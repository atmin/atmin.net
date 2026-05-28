package main

import (
	"context"
	"net/http"
	"testing"
)

func TestRotationRecord_RoundTrip_Success(t *testing.T) {
	store := NewMemStore()
	rec := RotationRecord{
		Status:     http.StatusOK,
		Token:      "tok",
		KeyVersion: 2,
	}
	if err := saveRotationRecord(context.Background(), store, "u1", "req-1", rec); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, ok, err := loadRotationRecord(context.Background(), store, "u1", "req-1")
	if err != nil || !ok {
		t.Fatalf("load: ok=%v err=%v", ok, err)
	}
	if got.Token != "tok" || got.KeyVersion != 2 || got.Status != http.StatusOK {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}

func TestRotationRecord_RoundTrip_Failure(t *testing.T) {
	store := NewMemStore()
	rec := RotationRecord{
		Status:  http.StatusConflict,
		Error:   "key_version_stale",
		Current: 4,
	}
	if err := saveRotationRecord(context.Background(), store, "u1", "req-2", rec); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, ok, _ := loadRotationRecord(context.Background(), store, "u1", "req-2")
	if !ok || got.Error != "key_version_stale" || got.Current != 4 {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
	// Replay body should carry `current` and the canonical error message.
	body := got.Body()
	if body["current"] != 4 {
		t.Fatalf("body current = %v, want 4", body["current"])
	}
	if body["error"] != "key_version_stale" {
		t.Fatalf("body error = %v, want key_version_stale", body["error"])
	}
}

func TestRotationRecord_UnknownReturnsNotOK(t *testing.T) {
	store := NewMemStore()
	_, ok, err := loadRotationRecord(context.Background(), store, "u1", "nope")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if ok {
		t.Fatal("ok = true, want false for unknown request_id")
	}
}

func TestRotationRecord_StoredAtExpectedKey(t *testing.T) {
	store := NewMemStore()
	_ = saveRotationRecord(context.Background(), store, "u1", "req-x", RotationRecord{Status: 200})
	if _, err := store.GetObject(context.Background(), "users/u1/rotation-records/req-x.json"); err != nil {
		t.Fatalf("expected object at users/u1/rotation-records/req-x.json: %v", err)
	}
}
