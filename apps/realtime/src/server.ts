import type * as Party from "partykit/server"

const HEALTH_BODY = JSON.stringify({ status: "healthy", service: "realtime" })

export default class Server implements Party.Server {
  static onBeforeRequest(request: Party.Request) {
    // Liveness probe for Docker/Coolify healthchecks and load balancers.
    // PartyKit only routes requests to parties, so the probe lives on the main
    // party at /parties/main/health (publicly reachable through the /ws Traefik
    // prefix). A root /health stays a PartyKit 404. WebSocket connections never
    // reach this handler.
    const { pathname } = new URL(request.url)
    if (pathname.endsWith("/health")) {
      return new Response(HEALTH_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("Access denied", { status: 403 })
  }

  static onBeforeConnect() {
    return new Response("Access denied", { status: 403 })
  }

  onError(): void | Promise<void> {
    return
  }
}
