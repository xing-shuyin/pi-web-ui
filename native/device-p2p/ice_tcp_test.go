package main

import (
	"context"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pion/turn/v5"
)

// Exercise the production helper against a real TURN listener with no UDP listener.
// A relay candidate here proves ?transport=tcp reaches TURN, not merely that its URL parses.
func TestGatherTURNOverTCP(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if listener.Addr().(*net.TCPAddr).Port < 8900 {
		t.Fatal("test port below allowed range")
	}
	server, err := turn.NewServer(turn.ServerConfig{
		Realm: "pi-test",
		AuthHandler: func(request *turn.RequestAttributes) (string, []byte, bool) {
			return request.Username, turn.GenerateAuthKey(request.Username, request.Realm, "test-only"), request.Username == "test"
		},
		ListenerConfigs: []turn.ListenerConfig{{Listener: listener, RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
			RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1",
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	h := &helper{ctx: ctx, cancel: cancel}
	defer func() {
		if h.listener != nil {
			h.listener.Close()
		}
		if h.pc != nil {
			h.pc.Close()
		}
	}()
	err = h.start(command{Role: "source", Loopback: true, Turn: &turnConfig{
		URLs: []string{fmt.Sprintf("turn:%s?transport=tcp", listener.Addr())}, Username: "test", Credential: "test-only",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(h.pc.LocalDescription().SDP, " typ relay ") {
		t.Fatal("TURN/TCP produced no relay candidate")
	}
}
