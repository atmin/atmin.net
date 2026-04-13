package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// MemStore is an in-memory Store for unit tests.
type MemStore struct {
	mu      sync.RWMutex
	objects map[string][]byte
}

func NewMemStore() *MemStore {
	return &MemStore{objects: make(map[string][]byte)}
}

func (m *MemStore) GetObject(_ context.Context, key string) ([]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	data, ok := m.objects[key]
	if !ok {
		return nil, ErrNotFound
	}
	return append([]byte(nil), data...), nil // return a copy
}

func (m *MemStore) PutObject(_ context.Context, key string, data []byte, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objects[key] = append([]byte(nil), data...) // store a copy
	return nil
}

func (m *MemStore) HeadObject(_ context.Context, key string) error {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, ok := m.objects[key]; !ok {
		return ErrNotFound
	}
	return nil
}

func (m *MemStore) DeleteObject(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objects, key)
	return nil
}

func (m *MemStore) DeleteObjects(_ context.Context, keys []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range keys {
		delete(m.objects, k)
	}
	return nil
}

func (m *MemStore) ListObjects(_ context.Context, prefix string, limit int, cursor string) ([]string, string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var keys []string
	for k := range m.objects {
		if strings.HasPrefix(k, prefix) && (cursor == "" || k > cursor) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)

	if len(keys) > limit {
		nextCursor := keys[limit-1]
		return keys[:limit], nextCursor, nil
	}
	return keys, "", nil
}

func (m *MemStore) ListObjectSizes(_ context.Context, prefix string, limit int) (int64, int, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var keys []string
	for k := range m.objects {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	truncated := len(keys) > limit
	if truncated {
		keys = keys[:limit]
	}
	var total int64
	for _, k := range keys {
		total += int64(len(m.objects[k]))
	}
	return total, len(keys), truncated, nil
}

func (m *MemStore) PresignPut(_ context.Context, key string, _ int64, _ time.Duration) (string, error) {
	// In tests, return a fake URL. The actual upload goes through PutObject.
	return fmt.Sprintf("http://fake-presign/%s", key), nil
}
