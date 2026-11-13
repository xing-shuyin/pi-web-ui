package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// 对称 NAT 端口预测：NAT 通常按递增方式分配新映射，因此把探测到的 srflx 端口
// 前后各扩展一段，作为「预测候选」写进 SDP。对端会向这些端口发 STUN 检查，
// 只要其中一条命中我们当前的映射（我们也同时在向对端发包），打洞即成功。
// 参考同类项目做法（-15 .. +35），这里收窄到 -12 .. +28 以控制在候选上限内。
const (
	predictBefore = 12
	predictAfter  = 28
	maxCandidates = 56
)

// predictCandidates 在本地 SDP 里追加预测的 srflx 候选；没有 srflx（无 STUN）时原样返回。
func predictCandidates(sdp string) string {
	// 默认关闭：真实 srflx 候选通常已足够，预测候选会把候选对数量放大一个量级，
	// 反而让 ICE 在超时前检查不完。需要时用 PI_DEVICE_P2P_PREDICT=1 打开。
	if os.Getenv("PI_DEVICE_P2P_PREDICT") != "1" {
		return sdp
	}
	lines := strings.Split(sdp, "\r\n")
	var basePort, ip string
	localPort := 0
	candidates := 0
	lastCandidate := -1
	for index, line := range lines {
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		candidates++
		lastCandidate = index
		fields := strings.Fields(line)
		if len(fields) < 8 || !containsType(fields, "srflx") {
			continue
		}
		port, err := strconv.Atoi(fields[5])
		if err != nil {
			continue
		}
		// 取最大的 srflx 端口作为基准（多网卡时通常是最新分配的映射）。
		if port > atoiSafe(basePort) {
			basePort = fields[5]
			ip = fields[4]
			localPort = candidateRPort(fields)
		}
	}
	base, err := strconv.Atoi(basePort)
	if ip == "" || err != nil || lastCandidate < 0 {
		return sdp
	}
	// 公网端口与本地端口一致 = 端口保持型 NAT，直连候选已经足够，无需预测。
	if localPort == base {
		return sdp
	}
	extra := make([]string, 0, predictBefore+predictAfter)
	for port := base - predictBefore; port <= base+predictAfter; port++ {
		if port == base || port < 1 || port > 65535 {
			continue
		}
		if candidates+len(extra) >= maxCandidates {
			break
		}
		extra = append(extra, fmt.Sprintf("a=candidate:900%d 1 udp 1694498815 %s %d typ srflx raddr 0.0.0.0 rport 0", port, ip, port))
	}
	if len(extra) == 0 {
		return sdp
	}
	out := make([]string, 0, len(lines)+len(extra))
	for index, line := range lines {
		out = append(out, line)
		if index == lastCandidate {
			out = append(out, extra...)
		}
	}
	return strings.Join(out, "\r\n")
}

func candidateRPort(fields []string) int {
	for index := 0; index+1 < len(fields); index++ {
		if fields[index] == "rport" {
			return atoiSafe(fields[index+1])
		}
	}
	return 0
}

func containsType(fields []string, want string) bool {
	for index := 0; index+1 < len(fields); index++ {
		if fields[index] == "typ" && fields[index+1] == want {
			return true
		}
	}
	return false
}

func atoiSafe(value string) int {
	number, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return number
}
