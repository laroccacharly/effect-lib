# Local port management: Portless trade-offs

## Goal

Run multiple local Effect applications without manually choosing ports or encountering port conflicts. The Effect service should expose the address selected for each server. Stable, named URLs are useful only if an application or another tool needs to find the server without already knowing its address.

**The simplest solution does not need a daemon or a reverse proxy:** bind each server to `127.0.0.1` with port `0`. The operating system chooses an available port as part of the bind, and `HttpServer.address` exposes the actual port. The port may change at each restart; consumers must discover the new address. This is safer than finding a free port, releasing it, and subsequently trying to bind it: another process can claim that port in between.

If apps need to find each other by name, add a small local registry. If browsers or external tools need a stable URL, add a shared proxy and its lifecycle. Those are separate requirements, not prerequisites for conflict-free port assignment.

## Upstream components

Counts are physical lines in `../portless/packages/portless/src` at checkout `49586cf`, including blank lines and comments; they exclude tests and build output. They are **whole-file counts**, not estimates of how much code must be copied. Shared files contain features from multiple categories. The recommendations below are for the goal above, not for full Portless compatibility.

| Component / upstream files | Lines | Main feature | Keep? |
| --- | ---: | --- | --- |
| CLI (`cli.ts`, `cli-utils.ts`, `colors.ts`) | 7,833 | Launch commands, select ports, start/discover the daemon, show status, and coordinate many optional features. | **No CLI** for an Effect API. Port `0` replaces free-port probing for an Effect server. If we want a shared proxy, keep or reimplement only the startup, discovery and coordination pieces. |
| Proxy (`proxy.ts`, `pages.ts`, `fonts.ts`, `types.ts`) | 1,518 | Route HTTP and WebSocket traffic by hostname; serve status and error pages; optional TLS/HTTP2. | **No** for automatic port assignment alone. **Yes, in some form** for stable named browser URLs. Error-page styling and embedded fonts are optional. |
| Shared route store (`routes.ts`) | 434 | Persist routes, lock updates, detect name conflicts, and clean up dead owners. | **No** if callers only need their own bound address. **Some form** if multiple processes need name-based discovery or a shared proxy. |
| Utilities (`utils.ts`) | 321 | Hostname parsing, URL formatting, loopback connections and filesystem helpers. | **Partly**, depending on design. Most are unnecessary for port `0` alone. |
| Automatic app detection (`auto.ts`) | 360 | Infer app names, scripts and framework behavior. | **No**: the Effect application can supply its own name. |
| Configuration (`config.ts`) | 493 | Read and resolve Portless project configuration. | **No**: use Effect layer options. |
| Workspaces (`workspace.ts`) | 274 | Discover and coordinate workspace applications. | **No**: each Effect app can register itself. |
| Docker Compose (`compose.ts`) | 493 | Manage routes and port assignments for Compose services. | **No** for local Effect servers. |
| Turbo integration (`turbo.ts`) | 107 | Work with Turborepo configuration. | **No**. |
| Certificates (`certs.ts`, `windows-ca.ts`) | 1,412 | Create, manage and trust local TLS certificates across platforms. | **No** for port assignment or plain HTTP. **Only if** trusted local HTTPS is a requirement. |
| Hosts file and authorization (`hosts.ts`, `hosts-sync-auth.ts`) | 234 | Manage hosts-file entries and authorize hosts synchronization. | **No** for port assignment. Usually unnecessary for `.localhost` names where the client resolves them to loopback. |
| OS service (`service.ts`) | 1,290 | Install and manage the proxy as a persistent startup service. | **No** for port assignment. Optional even for a proxy: an on-demand daemon can be started without installing a system service. |
| LAN discovery (`lan-ip.ts`, `mdns.ts`) | 313 | LAN address selection and mDNS advertisement. | **No** for same-machine access. |
| Tailscale (`tailscale.ts`) | 435 | Share routes over Tailscale. | **No** for same-machine access. |
| External tunnels (`cloudflare.ts`, `tunnel.ts`) | 321 | Publish routes through Cloudflare or other tunnel providers. | **No** for same-machine access. |
| MCP (`mcp.ts`) | 863 | Expose Portless operations to MCP clients. | **No** for an Effect service. |
| Cleanup helpers (`clean-utils.ts`) | 95 | Clean up persisted Portless state. | **No** for port `0`. A registry or daemon would need its own limited cleanup. |
| Entry point (`index.ts`) | 5 | Re-export public APIs. | **No**; Effect lib has its own exports. |
| **Total** | **16,801** | | |

## Options

| Option | What it provides | Additional moving parts | Main limitation |
| --- | --- | --- | --- |
| **A. OS-assigned port** | Each app starts on a collision-free port and receives its actual address. | None beyond the server and Effect layer. | Address changes on restart; other processes need a way to discover it. |
| **B. Port + registry** | A, plus lookup by app name across processes. | Shared state or a local IPC service; synchronization, owner-aware cleanup, stale-entry handling. | Names resolve to changing `localhost:port` addresses, not a stable browser URL. |
| **C. Shared Portless daemon** | Stable named URLs for independent apps, plus dynamic backend ports. | Proxy startup/discovery, shared routes and lifecycle; optionally TLS and trust. | More plumbing; the proxy itself needs a known shared address and can conflict with another listener. |

## Recommendation

Start with **A** if the only requirement is that each server starts without a port conflict and the application can print or pass its address. Add **B** only if other processes need to look up an app by name. Choose **C** only if a stable named URL is itself important—for example, bookmarks, browser cookies, OAuth callbacks, or tools that must keep the same address across restarts.

The current `src/portless` implementation is **not C**: its proxy and route map are process-local, so independent applications cannot share its default proxy port. If choosing A, it should be replaced rather than vendoring Portless. If choosing C, the existing `portless` npm package has no runtime npm dependencies, so using its daemon may be less maintenance than vendoring it; a compatibility and lifecycle investigation is still needed before committing to that design.
