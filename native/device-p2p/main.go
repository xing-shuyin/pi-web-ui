package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"sync"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

const chunkSize = 16 * 1024
const highWater = 256 * 1024
const maxStreams = 32

type turnConfig struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

type command struct {
	Type     string      `json:"type"`
	Role     string      `json:"role"`
	SDP      string      `json:"sdp"`
	Port     int         `json:"port"`
	STUN     []string    `json:"stun"`
	Turn     *turnConfig `json:"turn"`
	Loopback bool        `json:"loopback"`
}

type helper struct {
	ctx      context.Context
	cancel   context.CancelFunc
	pc       *webrtc.PeerConnection
	listener net.Listener
	outputMu sync.Mutex
	streams  sync.Map
	count    atomic.Int32
	pending  atomic.Int32
	sequence atomic.Uint64
	bytes    atomic.Uint64
	ready    sync.Once
	relay    bool
}

func (h *helper) emit(value any) {
	h.outputMu.Lock()
	defer h.outputMu.Unlock()
	if json.NewEncoder(os.Stdout).Encode(value) != nil {
		h.cancel()
	}
}

func (h *helper) bridge(dc *webrtc.DataChannel, tcp net.Conn) {
	if h.count.Add(1) > maxStreams {
		h.count.Add(-1)
		h.streams.Delete(tcp)
		_ = tcp.Close()
		_ = dc.Close()
		return
	}
	low := make(chan struct{}, 1)
	done := make(chan struct{})
	rw, err := dc.Detach()
	if err != nil {
		h.count.Add(-1)
		h.streams.Delete(tcp)
		_ = tcp.Close()
		_ = dc.Close()
		return
	}
	var once sync.Once
	stop := func() {
		once.Do(func() {
			close(done)
			_ = tcp.Close()
			_ = rw.Close()
			h.streams.Delete(tcp)
			h.count.Add(-1)
		})
	}
	h.streams.Store(tcp, stop)
	dc.SetBufferedAmountLowThreshold(highWater / 2)
	dc.OnBufferedAmountLow(func() {
		select {
		case low <- struct{}{}:
		default:
		}
	})
	dc.OnClose(stop)
	go func() {
		select {
		case <-h.ctx.Done():
			stop()
		case <-done:
		}
	}()
	go func() {
		defer stop()
		_, _ = io.CopyBuffer(tcp, rw, make([]byte, 64*1024))
	}()
	go func() {
		defer stop()
		buf := make([]byte, chunkSize)
		for {
			n, readErr := tcp.Read(buf)
			if n > 0 {
				for dc.BufferedAmount() > highWater {
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
				written, writeErr := rw.Write(buf[:n])
				h.bytes.Add(uint64(written))
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

func (h *helper) connected(port int) {
	h.ready.Do(func() {
		// 数据通道先于候选对就绪是常见竞态：给 ICE 一点时间结算，别把刚建好的连接掐掉。
		var pair *webrtc.ICECandidatePair
		for attempt := 0; attempt < 40; attempt++ {
			selected, err := h.pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
			if err == nil && selected != nil {
				pair = selected
				break
			}
			time.Sleep(25 * time.Millisecond)
		}
		if pair == nil {
			fmt.Fprintln(os.Stderr, "device-p2p: data channel opened without a selected candidate pair")
			h.cancel()
			return
		}
		// Without TURN a relayed pair cannot be reached intentionally: it means the media would
		// bounce through a third party the operator did not configure.
		relayed := pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay
		if relayed && !h.relay {
			fmt.Fprintln(os.Stderr, "device-p2p: ICE selected a relay pair but no TURN server is configured")
			h.cancel()
			return
		}
		h.emit(map[string]any{"type": "ready", "port": port, "localCandidate": pair.Local.Typ.String(), "remoteCandidate": pair.Remote.Typ.String(), "protocol": pair.Local.Protocol.String(), "relayed": relayed})
	})
}

func (h *helper) start(c command) error {
	if c.Role != "source" && c.Role != "target" {
		return errors.New("invalid role")
	}
	if len(c.STUN) > 4 || len(c.SDP) > 32768 {
		return errors.New("request exceeds limit")
	}
	if c.Turn != nil {
		if len(c.Turn.URLs) == 0 || len(c.Turn.URLs) > 3 || len(c.Turn.Username) > 256 || len(c.Turn.Credential) > 256 {
			return errors.New("invalid TURN configuration")
		}
		if c.Turn.Username == "" || c.Turn.Credential == "" || strings.ContainsRune(c.Turn.Username+c.Turn.Credential, 0) {
			return errors.New("invalid TURN credentials")
		}
	}
	settings := webrtc.SettingEngine{}
	settings.DetachDataChannels()
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
	settings.SetSCTPMaxReceiveBufferSize(1024 * 1024)
	settings.SetICETimeouts(8*time.Second, 15*time.Second, 2*time.Second)
	// 固定本地端口段，使对称 NAT 的公网映射呈线性递增，端口预测才有意义。
	if err := settings.SetEphemeralUDPPortRange(50000, 50100); err != nil {
		return err
	}
	settings.SetSTUNGatherTimeout(1500 * time.Millisecond)
	if c.Loopback {
		settings.SetIncludeLoopbackCandidate(true)
		settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	}
	servers := []webrtc.ICEServer{}
	for _, url := range c.STUN {
		if !regexp.MustCompile(`^stun:[a-zA-Z0-9.\-\[\]:]+$`).MatchString(url) || len(url) > 256 {
			return errors.New("invalid STUN server")
		}
		servers = append(servers, webrtc.ICEServer{URLs: []string{url}})
	}
	if c.Turn != nil {
		for _, url := range c.Turn.URLs {
			if !regexp.MustCompile(`^turns?:[a-zA-Z0-9.\-\[\]:]+$`).MatchString(url) || len(url) > 256 {
				return errors.New("invalid TURN server")
			}
		}
		servers = append(servers, webrtc.ICEServer{URLs: c.Turn.URLs, Username: c.Turn.Username, Credential: c.Turn.Credential})
		h.relay = true
	}
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return err
	}
	h.pc = pc
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			h.cancel()
		}
	})
	var description webrtc.SessionDescription
	if c.Role == "source" {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			return err
		}
		h.listener = listener
		port := listener.Addr().(*net.TCPAddr).Port
		dc, err := pc.CreateDataChannel("bootstrap", nil)
		if err != nil {
			return err
		}
		dc.OnOpen(func() {
			rw, err := dc.Detach()
			if err != nil {
				h.cancel()
				return
			}
			go func() { _, _ = io.Copy(io.Discard, rw); h.cancel() }()
			h.connected(port)
		})
		go func() {
			for {
				tcp, err := listener.Accept()
				if err != nil {
					return
				}
				if pc.ConnectionState() != webrtc.PeerConnectionStateConnected || h.count.Load() >= maxStreams {
					_ = tcp.Close()
					continue
				}
				if h.pending.Add(1) > maxStreams {
					h.pending.Add(-1)
					_ = tcp.Close()
					continue
				}
				var pendingOnce sync.Once
				releasePending := func() { pendingOnce.Do(func() { h.pending.Add(-1) }) }
				dc, err := pc.CreateDataChannel(fmt.Sprintf("stream-%d", h.sequence.Add(1)), nil)
				if err != nil {
					releasePending()
					_ = tcp.Close()
					continue
				}
				// Track pre-open sockets too: remote shutdown must not leave an accepted socket behind.
				h.streams.Store(tcp, func() { releasePending(); _ = tcp.Close(); _ = dc.Close() })
				timer := time.AfterFunc(5*time.Second, func() { releasePending(); _ = tcp.Close(); _ = dc.Close(); h.streams.Delete(tcp) })
				dc.OnOpen(func() {
					releasePending()
					if !timer.Stop() {
						_ = dc.Close()
						return
					}
					h.bridge(dc, tcp)
				})
			}
		}()
		description, err = pc.CreateOffer(nil)
	} else {
		if c.Port <= 0 || c.Port > 65535 {
			return errors.New("invalid target port")
		}
		labels := regexp.MustCompile(`^stream-[1-9][0-9]{0,9}$`)
		var bootSeen atomic.Bool
		pc.OnDataChannel(func(dc *webrtc.DataChannel) {
			if dc.Label() == "bootstrap" {
				if !bootSeen.CompareAndSwap(false, true) {
					_ = dc.Close()
					return
				}
				dc.OnOpen(func() {
					rw, err := dc.Detach()
					if err != nil {
						h.cancel()
						return
					}
					go func() { _, _ = io.Copy(io.Discard, rw); h.cancel() }()
					h.connected(0)
				})
				return
			}
			if !labels.MatchString(dc.Label()) || h.count.Load() >= maxStreams {
				_ = dc.Close()
				return
			}
			if h.pending.Add(1) > maxStreams {
				h.pending.Add(-1)
				_ = dc.Close()
				return
			}
			var pendingOnce sync.Once
			releasePending := func() { pendingOnce.Do(func() { h.pending.Add(-1) }) }
			dc.OnClose(releasePending)
			timer := time.AfterFunc(5*time.Second, func() { releasePending(); _ = dc.Close() })
			dc.OnOpen(func() {
				releasePending()
				if !timer.Stop() {
					_ = dc.Close()
					return
				}
				tcp, err := (&net.Dialer{Timeout: 2 * time.Second}).DialContext(h.ctx, "tcp4", fmt.Sprintf("127.0.0.1:%d", c.Port))
				if err != nil {
					_ = dc.Close()
					return
				}
				h.bridge(dc, tcp)
			})
		})
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: c.SDP}); err != nil {
			return err
		}
		description, err = pc.CreateAnswer(nil)
	}
	if err != nil {
		return err
	}
	gather := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(description); err != nil {
		return err
	}
	select {
	case <-gather:
	case <-h.ctx.Done():
		return h.ctx.Err()
	case <-time.After(3 * time.Second):
		// A slow or unreachable TURN server must not abort the whole attempt (it would turn any
		// broken relay config into "no P2P at all"). Send the candidates gathered so far.
	}
	sdp := predictCandidates(pc.LocalDescription().SDP)
	if len(sdp) > 32768 {
		return errors.New("SDP exceeds limit")
	}
	h.emit(map[string]any{"type": "sdp", "sdp": sdp})
	return nil
}

func run() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	h := &helper{ctx: ctx, cancel: cancel}
	defer func() {
		cancel()
		if h.listener != nil {
			_ = h.listener.Close()
		}
		h.streams.Range(func(_, value any) bool { value.(func())(); return true })
		if h.pc != nil {
			_ = h.pc.Close()
		}
	}()
	commands := make(chan command)
	go func() {
		defer close(commands)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 64*1024)
		for scanner.Scan() {
			var c command
			if json.Unmarshal(scanner.Bytes(), &c) != nil {
				return
			}
			select {
			case commands <- c:
			case <-ctx.Done():
				return
			}
		}
	}()
	answered := false
	for {
		select {
		case c, ok := <-commands:
			if !ok || c.Type == "close" {
				return nil
			}
			switch c.Type {
			case "start":
				if h.pc != nil {
					return errors.New("already started")
				}
				if err := h.start(c); err != nil {
					return err
				}
			case "answer":
				if h.pc == nil || h.listener == nil || answered || len(c.SDP) > 32768 {
					return errors.New("invalid answer")
				}
				answered = true
				if err := h.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: c.SDP}); err != nil {
					return err
				}
			default:
				return errors.New("invalid command")
			}
		case <-ctx.Done():
			return nil
		}
	}
}

func main() {
	if run() != nil {
		os.Exit(1)
	}
}
