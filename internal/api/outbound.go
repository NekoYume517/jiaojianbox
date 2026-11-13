package api

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// User-supplied model endpoints are fetched by the server. Keep this off by
// default on public deployments; local desktop deployments can explicitly opt
// in when they need an Ollama/LAN endpoint.
func privateUpstreamsAllowed() bool {
	switch strings.ToLower(strings.TrimSpace(env("JJB_ALLOW_PRIVATE_UPSTREAMS", "false"))) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

var blockedOutboundPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

func outboundIPAllowed(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsUnspecified() || addr.IsLoopback() || addr.IsMulticast() || addr.IsLinkLocalUnicast() || addr.IsPrivate() {
		return false
	}
	for _, prefix := range blockedOutboundPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return addr.IsGlobalUnicast()
}

func outboundURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, "\\\r\n\x00") {
		return nil, errors.New("请填写有效的 HTTP/HTTPS 地址")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Opaque != "" || parsed.Hostname() == "" {
		return nil, errors.New("请填写有效的 HTTP/HTTPS 地址")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("模型接口只支持 HTTP/HTTPS")
	}
	if parsed.Scheme == "http" && !privateUpstreamsAllowed() {
		return nil, errors.New("公网部署的模型接口必须使用 HTTPS")
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("模型接口地址不能包含用户信息或片段")
	}
	if port := parsed.Port(); port != "" {
		number, portErr := strconv.Atoi(port)
		if portErr != nil || number < 1 || number > 65535 {
			return nil, errors.New("模型接口端口无效")
		}
	}
	return parsed, nil
}

func resolveOutboundHost(ctx context.Context, host string) ([]net.IP, error) {
	if literal := net.ParseIP(strings.Trim(host, "[]")); literal != nil {
		if !privateUpstreamsAllowed() && !outboundIPAllowed(literal) {
			return nil, errors.New("模型接口不能访问本机、内网或保留地址")
		}
		return []net.IP{literal}, nil
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("模型接口域名解析失败: %w", err)
	}
	if len(addresses) == 0 {
		return nil, errors.New("模型接口域名没有可用地址")
	}
	result := make([]net.IP, 0, len(addresses))
	for _, address := range addresses {
		if !privateUpstreamsAllowed() && !outboundIPAllowed(address.IP) {
			return nil, errors.New("模型接口不能解析到本机、内网或保留地址")
		}
		result = append(result, address.IP)
	}
	return result, nil
}

func validateOutboundURL(ctx context.Context, raw string) error {
	parsed, err := outboundURL(raw)
	if err != nil {
		return err
	}
	_, err = resolveOutboundHost(ctx, parsed.Hostname())
	return err
}

func validateStoredOutboundURL(raw string) error {
	parsed, err := outboundURL(raw)
	if err != nil {
		return err
	}
	if literal := net.ParseIP(strings.Trim(parsed.Hostname(), "[]")); literal != nil && !privateUpstreamsAllowed() && !outboundIPAllowed(literal) {
		return errors.New("模型接口不能访问本机、内网或保留地址")
	}
	return nil
}

func outboundRequest(ctx context.Context, method, raw string, body *strings.Reader) (*http.Request, error) {
	parsed, err := outboundURL(raw)
	if err != nil {
		return nil, err
	}
	if _, err = resolveOutboundHost(ctx, parsed.Hostname()); err != nil {
		return nil, err
	}
	if body == nil {
		return http.NewRequestWithContext(ctx, method, parsed.String(), nil)
	}
	return http.NewRequestWithContext(ctx, method, parsed.String(), body)
}

func outboundClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// Proxy settings are intentionally ignored for user-controlled endpoints:
	// a proxy could otherwise turn a blocked private hostname into a server-side
	// request. Resolve and dial the selected public IP directly as well, so DNS
	// rebinding cannot switch the target between validation and connection.
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if privateUpstreamsAllowed() {
			return dialer.DialContext(ctx, network, address)
		}
		addresses, err := resolveOutboundHost(ctx, host)
		if err != nil {
			return nil, err
		}
		var lastErr error
		for _, ip := range addresses {
			conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if dialErr == nil {
				return conn, nil
			}
			lastErr = dialErr
		}
		if lastErr == nil {
			lastErr = errors.New("模型接口没有可用连接")
		}
		return nil, lastErr
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
