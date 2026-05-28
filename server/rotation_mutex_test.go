package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRotationMutex_AcquireUncontended(t *testing.T) {
	mu := newRotationMutexMap()
	release, err := mu.acquire("u1", 100*time.Millisecond)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	release()
	if got := mu.size(); got != 0 {
		t.Fatalf("size = %d, want 0 after release", got)
	}
}

func TestRotationMutex_SerializesSameUser(t *testing.T) {
	mu := newRotationMutexMap()

	r1, err := mu.acquire("u1", 100*time.Millisecond)
	if err != nil {
		t.Fatalf("acquire 1: %v", err)
	}

	gotSecond := make(chan struct{})
	go func() {
		r2, err := mu.acquire("u1", 1*time.Second)
		if err != nil {
			t.Errorf("acquire 2: %v", err)
			return
		}
		close(gotSecond)
		r2()
	}()

	// Second acquire must NOT complete while the first is held.
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

func TestRotationMutex_DifferentUsersDontSerialize(t *testing.T) {
	mu := newRotationMutexMap()
	r1, err := mu.acquire("u1", 100*time.Millisecond)
	if err != nil {
		t.Fatalf("acquire u1: %v", err)
	}
	defer r1()

	// While u1 is held, u2 must acquire without blocking.
	r2, err := mu.acquire("u2", 50*time.Millisecond)
	if err != nil {
		t.Fatalf("acquire u2: %v", err)
	}
	r2()
}

func TestRotationMutex_AcquireTimesOut(t *testing.T) {
	mu := newRotationMutexMap()
	r1, _ := mu.acquire("u1", 100*time.Millisecond)
	defer r1()

	start := time.Now()
	_, err := mu.acquire("u1", 50*time.Millisecond)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed < 40*time.Millisecond {
		t.Fatalf("returned too early: %v", elapsed)
	}
}

func TestRotationMutex_NoLeakAfterManyHandles(t *testing.T) {
	mu := newRotationMutexMap()
	const N = 200
	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			uid := "u" + string(rune('a'+(i%26))) + "-" + string(rune('a'+(i/26%26)))
			release, err := mu.acquire(uid, 1*time.Second)
			if err != nil {
				t.Errorf("acquire %s: %v", uid, err)
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

func TestRotationMutex_ReleaseIsIdempotent(t *testing.T) {
	mu := newRotationMutexMap()
	release, err := mu.acquire("u1", 100*time.Millisecond)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	release()
	release() // calling release twice must not panic or corrupt refCount
	if got := mu.size(); got != 0 {
		t.Fatalf("size = %d, want 0", got)
	}
}

func TestRotationMutex_ContendedThenDrained(t *testing.T) {
	// Two concurrent acquires on the same uid: exactly one should "see"
	// the lock at a time. Use an atomic counter to detect overlap.
	mu := newRotationMutexMap()
	const goroutines = 8
	var inside atomic.Int32
	var maxInside atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := mu.acquire("hot", 5*time.Second)
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
