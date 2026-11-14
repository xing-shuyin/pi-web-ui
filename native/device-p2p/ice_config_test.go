package main

import "testing"

func TestICEServerURLs(t *testing.T) {
	for _, raw := range []string{"turn:relay.example:3478?transport=tcp", "turn:relay.example?transport=udp", "turns:relay.example:5349?transport=tcp", "turn:[::1]:3478", "turn:relay.example"} {
		if !validICEServerURL(raw, true) {
			t.Errorf("valid TURN URL rejected: %s", raw)
		}
	}
	for _, raw := range []string{"turn:relay.example:0", "turn:relay.example:65536", "turn:relay.example?transport=http", "turn:user@host:3478", "turn:host:3478/path", "turn:host:3478#fragment", "turn:[not-ip]:3478", "stun:host:3478"} {
		if validICEServerURL(raw, true) {
			t.Errorf("invalid TURN URL accepted: %s", raw)
		}
	}
	if !validICEServerURL("stun:[::1]:3478", false) || validICEServerURL("stun:host:3478?transport=tcp", false) {
		t.Fatal("STUN validation differs from ICE parser")
	}
}
