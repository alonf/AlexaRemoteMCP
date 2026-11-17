# Examples

`local-client.mjs` starts the MCP HTTP service in-process with a fake Alexa adapter and a static test token, then lists the tools and calls `list_devices` over Streamable HTTP.

```powershell
npm run build
node examples/local-client.mjs
```

It needs no Amazon account, no network and no real devices. The token is a fixed test value that only works against this local instance; real deployments use OAuth.
