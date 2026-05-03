# NYAMSIKA LAN Com

## Run

```bash
npm install
npm start
```

## Default ports

- HTTP redirect / plain HTTP fallback: `3000`
- HTTPS (preferred for Chrome camera/microphone on LAN): `3443`

## Notes

- The app is already split into `server`, `html`, `css`, and `others` folders.
- The server auto-generates a self-signed certificate in `others/ssl/` when OpenSSL is available.
- For camera/microphone on Chrome over LAN, open the HTTPS address and allow the certificate warning once.
- To regenerate the self-signed certificate manually, run `bash others/ssl/generate-self-signed.sh` or pass your LAN IP as the first argument.
