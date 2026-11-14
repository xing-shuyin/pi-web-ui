package main

import (
	"net"
	"regexp"
	"strings"

	"github.com/pion/stun/v4"
)

var iceURLPattern = regexp.MustCompile(`^(stun|turn|turns):(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$`)

func validICEServerURL(raw string, turn bool) bool {
	parts := iceURLPattern.FindStringSubmatch(raw)
	if len(raw) > 256 || parts == nil || (turn && parts[1] == "stun") || (!turn && (parts[1] != "stun" || parts[4] != "")) {
		return false
	}
	if strings.HasPrefix(parts[2], "[") && net.ParseIP(strings.Trim(parts[2], "[]")) == nil {
		return false
	}
	uri, err := stun.ParseURI(raw)
	return err == nil && uri.Port > 0 && uri.Port <= 65535
}
