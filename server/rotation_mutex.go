package main

import (
	"errors"
	"sync"
	"time"
)

// rotationMutexMap serializes credential-rotation handlers per user_id.
//
// The production object store does not support conditional writes, so the
// GET-VERIFY-WRITE on profile.json needs an out-of-band serialization
// primitive (ADR-0012 — Concurrency control). For single-instance
// deployments this in-process map is sufficient; multi-instance migration
// to shared state (Redis SETNX, Postgres advisory locks, …) is a future
// ADR.
//
// A per-user buffered channel of size 1 acts as the semaphore; refCount
// keeps the entry alive while any goroutine is waiting and releases it
// once the last waiter has finished, so an account that rotates once
// doesn't pin a lock object forever.

type rotationMutexMap struct {
	mu sync.Mutex
	m  map[string]*rotationLock
}

type rotationLock struct {
	sem      chan struct{} // capacity 1; "hold" = put a token in, "release" = take it out
	refCount int
}

var errRotationContention = errors.New("rotation contention")

func newRotationMutexMap() *rotationMutexMap {
	return &rotationMutexMap{m: make(map[string]*rotationLock)}
}

// acquire returns a release function that the caller MUST invoke (defer is
// the easy way). Blocks up to `timeout`; on timeout returns
// errRotationContention without acquiring.
func (rm *rotationMutexMap) acquire(userID string, timeout time.Duration) (func(), error) {
	rm.mu.Lock()
	lock, ok := rm.m[userID]
	if !ok {
		lock = &rotationLock{sem: make(chan struct{}, 1)}
		rm.m[userID] = lock
	}
	lock.refCount++
	rm.mu.Unlock()

	select {
	case lock.sem <- struct{}{}:
		// acquired
	case <-time.After(timeout):
		rm.decrement(userID)
		return nil, errRotationContention
	}

	var released sync.Once
	release := func() {
		released.Do(func() {
			<-lock.sem // give back the semaphore token
			rm.decrement(userID)
		})
	}
	return release, nil
}

func (rm *rotationMutexMap) decrement(userID string) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	lock, ok := rm.m[userID]
	if !ok {
		return
	}
	lock.refCount--
	if lock.refCount == 0 {
		delete(rm.m, userID)
	}
}

// size returns the number of live lock entries; for tests/observability.
func (rm *rotationMutexMap) size() int {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	return len(rm.m)
}
