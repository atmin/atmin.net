package main

import (
	"errors"
	"sync"
	"time"
)

// handleMutexMap serializes handle-claim handlers per handle.
//
// Same pattern as rotationMutexMap (ADR-0012) for the same reason: the
// production object store does not support conditional writes, so the
// GET-then-PUT on handles/{handle}.json needs an out-of-band serialization
// primitive. ADR-0013 specifies this map for the register flow.
//
// A per-handle buffered channel of size 1 acts as the semaphore;
// refCount keeps the entry alive while any goroutine is waiting and
// releases it once the last waiter has finished, so popular handles
// don't permanently pin lock objects.

type handleMutexMap struct {
	mu sync.Mutex
	m  map[string]*handleLock
}

type handleLock struct {
	sem      chan struct{}
	refCount int
}

var errHandleClaimContention = errors.New("handle claim contention")

func newHandleMutexMap() *handleMutexMap {
	return &handleMutexMap{m: make(map[string]*handleLock)}
}

// acquire returns a release function that the caller MUST invoke. Blocks
// up to `timeout`; on timeout returns errHandleClaimContention without
// acquiring.
func (hm *handleMutexMap) acquire(handle string, timeout time.Duration) (func(), error) {
	hm.mu.Lock()
	lock, ok := hm.m[handle]
	if !ok {
		lock = &handleLock{sem: make(chan struct{}, 1)}
		hm.m[handle] = lock
	}
	lock.refCount++
	hm.mu.Unlock()

	select {
	case lock.sem <- struct{}{}:
		// acquired
	case <-time.After(timeout):
		hm.decrement(handle)
		return nil, errHandleClaimContention
	}

	var released sync.Once
	release := func() {
		released.Do(func() {
			<-lock.sem
			hm.decrement(handle)
		})
	}
	return release, nil
}

func (hm *handleMutexMap) decrement(handle string) {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	lock, ok := hm.m[handle]
	if !ok {
		return
	}
	lock.refCount--
	if lock.refCount == 0 {
		delete(hm.m, handle)
	}
}

// size returns the number of live lock entries; for tests/observability.
func (hm *handleMutexMap) size() int {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	return len(hm.m)
}
