package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHandleMutex_AcquireUncontended(t *testing.T) {
	mu := newHandleMutexMap()
	release, err := mu.acquire("alice", 100*time.Millisecond)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	release()
	if got := mu.size(); got != 0 {
		t.Fatalf("size = %d, want 0 after release", got)
	}
}

func TestHandleMutex_SerializesSameHandle(t *testing.T) {
	mu := newHandleMutexMap()

	r1, err := mu.acquire("alice", 100*time.Millisecond)
	if err != nil {
		t.Fatalf("acquire 1: %v", err)
	}

	gotSecond := make(chan struct{})
	go func() {
		r2, err := mu.acquire("alice", 1*time.Second)
		if err != nil {
			t.Errorf("acquire 2: %v", err)
			return
		}
		close(gotSecond)
		r2()
	}()

	select {
	case <-gotSecond:
		t.Fatal("second acquire returned while first was held")
	case <-time.After(50 * time.Millisecond):
	}

	r1()
	select {
	case <-gotSecond:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("second acquire didn't complete after release")
	}
	if got := mu.size(); got != 0 {
		t.Fatalf("size = %d, want 0 after final release", got)
	}
}

func TestHandleMutex_DifferentHandlesDontSerialize(t *testing.T) {
	mu := newHandleMutexMap()
	r1, err := mu.acquire("alice", 100*time.Millisecond)
	if err != nil {
		t.Fatalf("acquire alice: %v", err)
	}
	defer r1()

	r2, err := mu.acquire("bob", 50*time.Millisecond)
	if err != nil {
		t.Fatalf("acquire bob: %v", err)
	}
	r2()
}

func TestHandleMutex_AcquireTimesOut(t *testing.T) {
	mu := newHandleMutexMap()
	r1, _ := mu.acquire("alice", 100*time.Millisecond)
	defer r1()

	start := time.Now()
	_, err := mu.acquire("alice", 50*time.Millisecond)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed < 40*time.Millisecond {
		t.Fatalf("returned too early: %v", elapsed)
	}
}

func TestHandleMutex_NoLeakAfterManyHandles(t *testing.T) {
	mu := newHandleMutexMap()
	const N = 200
	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			handle := "user-" + string(rune('a'+(i%26))) + string(rune('a'+(i/26%26)))
			release, err := mu.acquire(handle, 1*time.Second)
			if err != nil {
				t.Errorf("acquire %s: %v", handle, err)
				return
			}
			release()
		}(i)
	}
	wg.Wait()
	if got := mu.size(); got != 0 {
		t.Fatalf("size = %d, want 0 after all releases (entries leaked)", got)
	}
}

func TestHandleMutex_ReleaseIsIdempotent(t *testing.T) {
	mu := newHandleMutexMap()
	release, err := mu.acquire("alice", 100*time.Millisecond)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	release()
	release()
	if got := mu.size(); got != 0 {
		t.Fatalf("size = %d, want 0", got)
	}
}

func TestHandleMutex_ContendedThenDrained(t *testing.T) {
	mu := newHandleMutexMap()
	const goroutines = 8
	var inside atomic.Int32
	var maxInside atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := mu.acquire("popular", 5*time.Second)
			if err != nil {
				t.Errorf("acquire: %v", err)
				return
			}
			n := inside.Add(1)
			if n > maxInside.Load() {
				maxInside.Store(n)
			}
			time.Sleep(2 * time.Millisecond)
			inside.Add(-1)
			release()
		}()
	}
	wg.Wait()
	if got := maxInside.Load(); got != 1 {
		t.Fatalf("maxInside = %d, want 1 (mutex didn't serialize)", got)
	}
}
