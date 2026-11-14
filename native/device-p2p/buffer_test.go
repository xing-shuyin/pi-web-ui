package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestWaitForBufferNotifiesOrPolls(t *testing.T) {
	var bytes atomic.Uint64
	bytes.Store(highWater + 4096)
	low, done := make(chan struct{}, 1), make(chan struct{})
	// No low-water callback fires: polling must still detect the drained buffer.
	time.AfterFunc(20*time.Millisecond, func() { bytes.Store(highWater) })
	if !waitForBuffer(context.Background(), bytes.Load, low, done, 300*time.Millisecond, 5*time.Millisecond) {
		t.Fatal("drained buffer should resume even if a callback was missed")
	}
}

func TestWaitForBufferPreservesSlowProgress(t *testing.T) {
	var bytes atomic.Uint64
	bytes.Store(highWater + 8192)
	low, done := make(chan struct{}, 1), make(chan struct{})
	// Overall wait exceeds the timeout, but real progress resets the stall timer.
	time.AfterFunc(80*time.Millisecond, func() { bytes.Store(highWater + 4096) })
	time.AfterFunc(160*time.Millisecond, func() { bytes.Store(highWater) })
	if !waitForBuffer(context.Background(), bytes.Load, low, done, 125*time.Millisecond, 5*time.Millisecond) {
		t.Fatal("ongoing progress must not be mistaken for a stalled stream")
	}
}

func TestWaitForBufferStopsOnStallAndCancel(t *testing.T) {
	amount := func() uint64 { return highWater + 1 }
	low, done := make(chan struct{}, 1), make(chan struct{})
	if waitForBuffer(context.Background(), amount, low, done, 30*time.Millisecond, 5*time.Millisecond) {
		t.Fatal("a permanently stalled stream must eventually close")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if waitForBuffer(ctx, amount, low, done, time.Second, 5*time.Millisecond) {
		t.Fatal("cancelled connections must stop waiting")
	}
}
