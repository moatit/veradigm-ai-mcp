// voice-gw: Drawbridge's SIP user agent ("an extension, like a desk phone") and media gateway.
//
// It registers to the PBX over TLS, answers calls to the extension, converts G.711 RTP (SRTP when the PBX
// offers it) to PCM for the Drawbridge voice harness over an internal WebSocket, plays the harness's audio
// back, relays DTMF, and performs blind transfers with SIP REFER. It holds no patient logic: tools, identity
// checks, audit, transcripts and the model connection all live in the Drawbridge server process.
//
// Secrets (SIP_USERNAME, SIP_PASSWORD, VOICE_GW_SECRET) come from the environment only and are never logged.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"flag"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/emiago/diago"
	"github.com/emiago/diago/media"
	"github.com/emiago/sipgo"
	"github.com/pion/stun/v3"
)

func main() {
	health := flag.Bool("healthcheck", false, "exit 0 when registered (container healthcheck)")
	flag.Parse()
	if *health {
		os.Exit(Healthcheck(env("VOICE_GW_STATUS_FILE", "/tmp/voice-gw-status.json")))
	}

	cfg, err := LoadConfig()
	// Library log lines can quote SIP headers (From/To carry the extension's auth user): every attribute and
	// message passes through Redact before it is written.
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo, ReplaceAttr: redactAttr(cfg)}))
	slog.SetDefault(log)
	if err != nil {
		log.Error("configuration invalid; not starting (fail closed)", "problems", err.Error())
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The local address we reach the PBX from (the interface on the egress network).
	bindIP, err := localIPFor(cfg.Proxies[0])
	if err != nil {
		log.Error("no route to the PBX proxy", "err", err.Error())
		os.Exit(3)
	}
	publicIP := cfg.PublicIP
	if publicIP == "" && cfg.StunServer != "" {
		if ip, err := stunPublicIP(cfg.StunServer); err == nil {
			publicIP = ip
		} else {
			log.Warn("STUN lookup failed; SDP will carry the container address (PBX must latch symmetric RTP)", "err", err.Error())
		}
	}

	EchoMarginDB = cfg.EchoGateDB
	// Outbound calls (stage 4): with srtp-required we offer RTP/SAVP (the PBX must accept SRTP); with the
	// synthetic-only rule we offer RTP/AVP plus SDES keys (encrypted if the PBX takes them, plain otherwise).
	media.RTPProfileSAVPDisable = cfg.MediaPolicy == PolicySRTPPreferred
	media.RTPPortStart = cfg.RTPMin
	media.RTPPortEnd = cfg.RTPMax

	// Client TLS: system roots, TLS 1.2+, certificate checked against the one allowed name.
	clientTLS := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: cfg.TLSServerName}
	ua, err := sipgo.NewUA(
		sipgo.WithUserAgent(cfg.AORUser),
		sipgo.WithUserAgentHostname(cfg.Realm),
		sipgo.WithUserAgenTLSConfig(clientTLS),
	)
	if err != nil {
		log.Error("UA init failed", "err", err.Error())
		os.Exit(3)
	}
	defer ua.Close()

	serverTLS, err := ephemeralServerTLS()
	if err != nil {
		log.Error("listener TLS init failed", "err", err.Error())
		os.Exit(3)
	}

	st := NewStatus(cfg.StatusFile)
	g := &Gateway{cfg: cfg, log: log, ua: ua, tlsConf: clientTLS, st: st, allowed: map[string]bool{}}
	st.Update(func(s *StatusSnapshot) {
		s.PublicIP = publicIP
		s.MediaRule = cfg.MediaPolicy
		s.Mode = cfg.Mode
		s.Transport = "tls"
	})

	tran := diago.Transport{
		Transport:    "tls",
		BindHost:     bindIP,
		BindPort:     5061,
		MediaSRTP:    1, // SDES: answer SRTP when offered (policy above decides whether plain RTP is allowed)
		TLSConf:      serverTLS,
		TLSURINoSIPS: true,
	}
	if publicIP != "" {
		tran.MediaExternalIP = net.ParseIP(publicIP)
	}
	g.dg = diago.NewDiago(ua,
		diago.WithLogger(log),
		diago.WithTransport(tran),
		diago.WithMediaConfig(diago.MediaConfig{Codecs: answerCodecs}),
		diago.WithServerRequestMiddleware(g.SourceGuard),
	)
	g.cli, err = sipgo.NewClient(ua, sipgo.WithClientNAT(), sipgo.WithClientHostname(bindIP))
	if err != nil {
		log.Error("client init failed", "err", err.Error())
		os.Exit(3)
	}

	if cfg.Mode == ModeGreetingEcho {
		if pcm, err := LoadWAV8k(cfg.GreetingWAV); err == nil {
			g.greeting = pcm
		} else {
			log.Warn("greeting clip not loaded; echo only", "err", err.Error())
		}
	}

	if err := g.dg.ServeBackground(ctx, g.HandleCall); err != nil {
		log.Error("SIP serve failed", "err", err.Error())
		os.Exit(3)
	}
	log.Info("voice-gw started", "mode", cfg.Mode, "media_rule", cfg.MediaPolicy, "proxies", len(cfg.Proxies),
		"public_ip_known", publicIP != "", "rtp_port_min", cfg.RTPMin, "rtp_port_max", cfg.RTPMax, "max_calls", cfg.MaxCalls)

	go g.ControlLoop(ctx)
	g.RegisterLoop(ctx)
	log.Info("voice-gw stopped")
}

func localIPFor(hostport string) (string, error) {
	host, port, err := net.SplitHostPort(hostport)
	if err != nil {
		return "", err
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return "", fmt.Errorf("resolve %s failed", host)
	}
	c, err := net.Dial("udp4", net.JoinHostPort(ips[0].String(), port)) // no packet is sent
	if err != nil {
		return "", err
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).IP.String(), nil
}

func stunPublicIP(server string) (string, error) {
	c, err := stun.Dial("udp4", server)
	if err != nil {
		return "", err
	}
	defer c.Close()
	type res struct {
		ip  string
		err error
	}
	ch := make(chan res, 1)
	msg := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	go func() {
		err := c.Do(msg, func(e stun.Event) {
			if e.Error != nil {
				ch <- res{err: e.Error}
				return
			}
			var xor stun.XORMappedAddress
			if err := xor.GetFrom(e.Message); err != nil {
				ch <- res{err: err}
				return
			}
			ch <- res{ip: xor.IP.String()}
		})
		if err != nil {
			ch <- res{err: err}
		}
	}()
	select {
	case r := <-ch:
		return r.ip, r.err
	case <-time.After(4 * time.Second):
		return "", fmt.Errorf("stun timeout")
	}
}

// ephemeralServerTLS: the SIP TLS listener inside the container (never published) needs a certificate to
// exist; calls arrive on our own outbound TLS connection to the proxy, not on this listener.
func ephemeralServerTLS() (*tls.Config, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "voice-gw.internal"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}, nil
}
