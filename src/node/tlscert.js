'use strict';

// Bundled self-signed keypair.
//
// TLS is always available: the same port serves both plaintext WS and
// TLS-wrapped WSS, auto-detected per connection (see looksLikeTls). This cert
// is a convenience for direct WSS clients and for TLS-intercepting networks —
// it is NOT a substitute for a real certificate on a public hostname, and
// clients must be configured to skip verification when they use it.

const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDfzCCAmegAwIBAgIUHjMRiNMglotYagoXx6xbAq46ugAwDQYJKoZIhvcNAQEL
BQAwTzELMAkGA1UEBhMCVFIxDTALBgNVBAgMBFRlc3QxDTALBgNVBAcMBFRlc3Qx
EzARBgNVBAoMCkhlbGxvVGhlcmUxDTALBgNVBAMMBFRlc3QwHhcNMjAxMjIwMTcx
NzIzWhcNMzAxMjE4MTcxNzIzWjBPMQswCQYDVQQGEwJUUjENMAsGA1UECAwEVGVz
dDENMAsGA1UEBwwEVGVzdDETMBEGA1UECgwKSGVsbG9UaGVyZTENMAsGA1UEAwwE
VGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJA4YO/K/zZB847
ba2n11j+FX4S7R26tjAltuNqVVlusG26h32WLzFQQkxmGcwwpsFZg6kMCuzsF8mv
U4KbjNPhP51ZLgzaOvxrCUTqpVzDA3xNGd/SI7a6MYogzJvPdjMhx5jKRl86N4TT
fjTHIuNdsgnTxLZaGWlZL4+TG7uHgCWf02i5KsFnNSbw4UJjkJwtaXn2KLvlAP+C
nj3qZ1sW7So2vztBXilyC0bgeKDJQnOdpEWX67CQIlRpKBucFxvUmHYKgsK+jLP5
IW7D9KrdVP52Qic07avzR/Cqx5yln7U/fWW/NhpszWVMamMVTBQ+muAYvRBkaLfe
F7kSKXMCAwEAAaNTMFEwHQYDVR0OBBYEFOEUi7cKUd+gyUPwONnmKnkynotcMB8G
A1UdIwQYMBaAFOEUi7cKUd+gyUPwONnmKnkynotcMA8GA1UdEwEB/wQFMAMBAf8w
DQYJKoZIhvcNAQELBQADggEBAD1oGOmaQ8oasuPgQHxg7nBqnICBCJ360kgpt4Rw
t6EQKwYXt+oGDoeGPeCPK/7245Yw4PzBAvAEYQtXoOLBnXIMUWpAsSjk+ahjnAS4
UjmjeeYHYnWANp05yQNR5v59ABCEg7lYY/he3uIhEfD7xHlEMAABpIeU+LqpVAs5
7bIjvhkNzibsK6B7/rcXiQUpX4kCOC8pp55OqyxQBgYrPbJ6qy9+XEY1yjb4xV6v
hd3AN9RF966mCMA2a2cNmnQf3vhJEutC19YILvOGtTHPnhstNPZ9BafXan8Keocq
JASL782BXQ2JvjK/dVf9yQEjY/8kFwnt4dSWcibcWYgXk10=
-----END CERTIFICATE-----`;

const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCyQOGDvyv82QfO
O22tp9dY/hV+Eu0durYwJbbjalVZbrBtuod9li8xUEJMZhnMMKbBWYOpDArs7BfJ
r1OCm4zT4T+dWS4M2jr8awlE6qVcwwN8TRnf0iO2ujGKIMybz3YzIceYykZfOjeE
0340xyLjXbIJ08S2WhlpWS+Pkxu7h4Aln9NouSrBZzUm8OFCY5CcLWl59ii75QD/
gp496mdbFu0qNr87QV4pcgtG4HigyUJznaRFl+uwkCJUaSgbnBcb1Jh2CoLCvoyz
+SFuw/Sq3VT+dkInNO2r80fwqsecpZ+1P31lvzYabM1lTGpjFUwUPprgGL0QZGi3
3he5EilzAgMBAAECggEATi2EeqqymR96e+m2ja4KFZ7CQFv+oMZNt0ojLxRowGN6
f3WKjPr8Ua14lldFQzenOy+OPerpM8XMHQmHH8Ym+ppUsyb0unBP5HrxQseCpO9m
rPKHwZFBVpfMuF7wPfm8RmqvRoSYXpWC2f+D35Pi6kMinYrCQJO9h2W1JUwIorLr
vSGNC3Mt7arFrwer7p8QCFaW84YQqaIZbHcff8BfA3CgE5/rLlP3eYSk59ANpNfh
xjjug5vJpUD5gRuwA1WFtKH3H56jBP6tN2W1JOme/fNt0CaIe8ybRP9FUyv1cpnz
GKkCjZ92wLApVRCUplhPnRiWh3TP6ogByd6NvOVsyQKBgQDqqdgByXnrHZ+hDDXQ
ezfoS9cEOUnVOPHRXYvJzYh5jQ2iogqInVqRFXPQ42l6Gxy4HOwnacV4U89maKvz
dVWFM7hhxF2TZ8veWjgBHGmaFwkDk0M3f2LJiW/bO87G2MiFWkBaCD09hy9UJElQ
5hFo70T+m7CSDTyNZBn9UTDUlQKBgQDCdgGsi1I5mj5O5MWaL2UHBasqSBVOQB4Y
3xpAWfmSyCuMxr/7q9kNGkw+0eWnVArNLBZP1Nh4G+9DjG3CKjrW92fXTxdoHPPR
t7yUQJYnLEBx/BZmyl5R+KXfRqXK250jmFEqToSTx1yg4sy8mlqFdkosVrBerQxV
L/Dje/Q75wKBgQDnTR5jNIp926c6gOSSaMIEsKxxt141U3nX2pMtCPBaj1Q/V+V2
H1Pj6fdMkLuo5gx61ddYSgOgxUuLL+U9hgwTzZUSmRF7eDYVJ2xIfA8DGW2DHqaE
j4V6DYQ53kvE6G1ONFV16OUkPpnCIDo8CWpjumSRajiy3WUwINkVPfAZuQKBgEtE
DYXRLvQopTE4DtuMuJetNADbgZOV8ZBC2hBKQvTzERgd3TT14L7XjOdLqo3HU57y
D3i6s0ZZ2ZPViK38VmXZwJFvhWnAuwZTDWR8UyG6WP9FSQ5kCXnEub7fw0/vDLU4
QUIUve/M3CdRYVkmjR7XGAJtUzpx1DIsqhoCYhfFAoGBAIBxMfZpt+HS8VsPi7dZ
Ezdh7bfCDUdGNWcgHejSZCqVGKBgeKA8t04jcqR1mc3ycOHIfF9uNCvgtF1d22O0
VexxGJWt9R4vTUhCM7IZdi+dtn8ubTdWOydCo+mIRTuLb2lIu2kcnhT+9IJmkJ+5
kShRo16nOL+9eQHMEa3E91Vt
-----END PRIVATE KEY-----`;

const defaultTlsCredentials = { cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY };

/**
 * A TLS record starts with content-type 0x16 (Handshake), which no HTTP method
 * can begin with — so one byte is enough to route a connection to either the
 * TLS wrapper or the plaintext handler.
 */
function looksLikeTls(chunk) {
  return chunk.length > 0 && chunk[0] === 0x16;
}

module.exports = {
  SELF_SIGNED_CERT,
  SELF_SIGNED_KEY,
  defaultTlsCredentials,
  looksLikeTls
};
