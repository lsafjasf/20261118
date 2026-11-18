#!/usr/bin/env bash
# Generate an ECDSA P-256 self-signed certificate (max 14 days, as required
# by the WebTransport serverCertificateHashes trust model).
set -euo pipefail

CERT_DIR="${1:-./cert}"
mkdir -p "$CERT_DIR"

openssl ecparam -name prime256v1 -genkey -noout -out "$CERT_DIR/key.pem"
openssl req -new -x509 -key "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" -days 13 \
  -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"

node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const der = readFileSync('$CERT_DIR/cert.pem')
const b64 = der.toString().match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/)[1].replace(/\s/g, '')
const raw = Buffer.from(b64, 'base64')
const hex = createHash('sha256').update(raw).digest('hex')
const fingerprint = hex.match(/.{2}/g).join(':').toUpperCase()
writeFileSync('$CERT_DIR/fingerprint.txt', fingerprint + '\n')
console.log('certificate fingerprint (sha-256):', fingerprint)
"

echo "certificate written to $CERT_DIR"
