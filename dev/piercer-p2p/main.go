// Local transport proof, not a production helper. Both peers run in this process.
// Only loopback ICE candidates are enabled; no external signaling or STUN is used.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v3"
)

const chunkSize = 16 * 1024
const highWater = 512 * 1024

var bytesCopied atomic.Uint64
var maxBuffered atomic.Uint64
var streams atomic.Uint64

func observeBuffered(n uint64) {
	for old := maxBuffered.Load(); n > old; old = maxBuffered.Load() {
		if maxBuffered.CompareAndSwap(old, n) {
			break
		}
	}
}

// Bound each stream's outgoing queue; do not enqueue a whole file or warm-up data.
func bridge(ctx context.Context, dc *webrtc.DataChannel, tcp net.Conn) {
	low := make(chan struct{}, 1)
	done := make(chan struct{})
	var stopOnce sync.Once
	var detached io.ReadWriteCloser
	stop := func() {
		stopOnce.Do(func() {
			close(done)
			_ = tcp.Close()
			if detached != nil {
				_ = detached.Close()
			}
		})
	}
	dc.SetBufferedAmountLowThreshold(highWater / 2)
	dc.OnBufferedAmountLow(func() {
		select {
		case low <- struct{}{}:
		default:
		}
	})
	var err error
	detached, err = dc.Detach()
	if err != nil {
		stop()
		return
	}
	dc.OnClose(stop)
	go func() {
		select {
		case <-ctx.Done():
			stop()
		case <-done:
		}
	}()
	go func() {
		defer stop()
		_, _ = io.CopyBuffer(tcp, detached, make([]byte, 64*1024))
	}()
	go func() {
		defer stop()
		buf := make([]byte, chunkSize)
		for {
			n, readErr := tcp.Read(buf)
			if n > 0 {
				for dc.BufferedAmount() > highWater {
					observeBuffered(dc.BufferedAmount())
					timer := time.NewTimer(5 * time.Second)
					select {
					case <-low:
						timer.Stop()
					case <-timer.C:
						return
					case <-done:
						timer.Stop()
						return
					}
				}
				written, writeErr := detached.Write(buf[:n])
				bytesCopied.Add(uint64(written))
				observeBuffered(dc.BufferedAmount())
				if writeErr != nil || written != n {
					return
				}
			}
			if readErr != nil {
				return
			}
		}
	}()
}

func negotiate(ctx context.Context, offerer, answerer *webrtc.PeerConnection) error {
	offer, err := offerer.CreateOffer(nil)
	if err != nil {
		return err
	}
	gather := webrtc.GatheringCompletePromise(offerer)
	if err = offerer.SetLocalDescription(offer); err != nil {
		return err
	}
	select {
	case <-gather:
	case <-ctx.Done():
		return ctx.Err()
	}
	if err = answerer.SetRemoteDescription(*offerer.LocalDescription()); err != nil {
		return err
	}
	answer, err := answerer.CreateAnswer(nil)
	if err != nil {
		return err
	}
	gather = webrtc.GatheringCompletePromise(answerer)
	if err = answerer.SetLocalDescription(answer); err != nil {
		return err
	}
	select {
	case <-gather:
	case <-ctx.Done():
		return ctx.Err()
	}
	return offerer.SetRemoteDescription(*answerer.LocalDescription())
}

func run() error {
	targetPort := flag.Int("target-port", 0, "fixed loopback TLS-PSK test server port")
	flag.Parse()
	if *targetPort < 8900 || *targetPort > 65535 {
		return fmt.Errorf("target port must be 8900..65535")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	settings := webrtc.SettingEngine{}
	settings.DetachDataChannels()
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	settings.SetSCTPMaxReceiveBufferSize(1024 * 1024)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	source, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	defer target.Close()
	ready := make(chan struct{})
	target.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() == "bootstrap" {
			dc.OnOpen(func() { close(ready) })
			return
		}
		if !strings.HasPrefix(dc.Label(), "stream-") {
			_ = dc.Close()
			return
		}
		dc.OnOpen(func() {
			tcp, err := net.DialTimeout("tcp4", fmt.Sprintf("127.0.0.1:%d", *targetPort), 2*time.Second)
			if err != nil {
				_ = dc.Close()
				return
			}
			bridge(ctx, dc, tcp)
		})
	})
	if _, err = source.CreateDataChannel("bootstrap", nil); err != nil {
		return err
	}
	if err = negotiate(ctx, source, target); err != nil {
		return err
	}
	select {
	case <-ready:
	case <-ctx.Done():
		return ctx.Err()
	}
	pair, err := source.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil {
		return fmt.Errorf("missing selected ICE pair: %v", err)
	}
	if pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay {
		return fmt.Errorf("unexpected relay candidate")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	if listener.Addr().(*net.TCPAddr).Port < 8900 {
		return fmt.Errorf("OS assigned a test port below 8900")
	}
	var live sync.Map
	defer live.Range(func(key, value any) bool { _ = key.(net.Conn).Close(); return true })
	go func() {
		for {
			tcp, err := listener.Accept()
			if err != nil {
				return
			}
			// This proof has a fixed lifetime and a bounded number of streams in total.
			id := streams.Add(1)
			if id > 16 {
				_ = tcp.Close()
				continue
			}
			live.Store(tcp, true)
			dc, err := source.CreateDataChannel(fmt.Sprintf("stream-%d", id), nil)
			if err != nil {
				_ = tcp.Close()
				continue
			}
			dc.OnOpen(func() { bridge(ctx, dc, tcp) })
		}
	}()
	enc := json.NewEncoder(os.Stdout)
	if err = enc.Encode(map[string]any{
		"type": "ready", "port": listener.Addr().(*net.TCPAddr).Port,
		"localCandidate": pair.Local.Typ.String(), "remoteCandidate": pair.Remote.Typ.String(),
		"protocol": pair.Local.Protocol.String(), "scope": "same-process-loopback",
	}); err != nil {
		return err
	}
	commands := make(chan string)
	go func() {
		defer close(commands)
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			select {
			case commands <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
	}()
	for {
		select {
		case cmd, ok := <-commands:
			if !ok || cmd == "quit" {
				return nil
			}
			if cmd == "stats" {
				_ = enc.Encode(map[string]any{"type": "stats", "bytes": bytesCopied.Load(), "maxBuffered": maxBuffered.Load(), "streams": streams.Load()})
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
