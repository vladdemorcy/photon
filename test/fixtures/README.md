# Test certificates

The stand-in IKEA hub and Lutron bridge in `test/mocks.js` need throwaway certificates. They aren't kept in the repository (they're private keys, even if only for testing), so make them once before running the mocks:

```
cd test/fixtures
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout dirigera-key.pem -out dirigera-cert.pem -days 3650 -subj "/CN=dirigera-test"
openssl req -x509 -newkey rsa:2048 -nodes -keyout lutron-ca-key.pem -out lutron-ca.pem -days 3650 -subj "/CN=Test Lutron CA"
openssl req -newkey rsa:2048 -nodes -keyout lutron-bridge-key.pem -out lutron-bridge.csr -subj "/CN=test-bridge"
openssl x509 -req -in lutron-bridge.csr -CA lutron-ca.pem -CAkey lutron-ca-key.pem -CAcreateserial -out lutron-bridge.pem -days 3650
rm lutron-bridge.csr lutron-ca.srl
```

`test/tv-mocks.js` uses the same `dirigera-*.pem` pair for its stand-in Vizio and Chromecast.
