package main

import (
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync/atomic"
)

// recoverCall contains a panic to the one call it happened in: the gateway, its registration and every other
// call keep running. It logs the panic (call reference, where, the stack; no audio, no caller data) and runs
// onPanic, normally a BYE for that call so the caller is not left in dead air. Use as
//
//	defer recoverCall(log, ref, "writeLoop", hangup)
func recoverCall(log *slog.Logger, ref, where string, onPanic func()) {
	r := recover()
	if r == nil {
		return
	}
	if log == nil {
		log = slog.Default()
	}
	log.Error("call goroutine panicked; ending this call only", "call", ref, "where", where, "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
	PanicsRecovered.Add(1)
	if onPanic != nil {
		func() {
			defer func() { _ = recover() }()
			onPanic()
		}()
	}
}

// PanicsRecovered counts contained per-call panics (status file and control link).
var PanicsRecovered atomic.Int64

// goSafe starts fn in a goroutine with recoverCall around it.
func goSafe(log *slog.Logger, ref, where string, onPanic func(), fn func()) {
	go func() {
		defer recoverCall(log, ref, where, onPanic)
		fn()
	}()
}
