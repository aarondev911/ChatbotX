import type * as Party from "partykit/server"

export default class Server implements Party.Server {
  static onBeforeRequest(request: Party.Request) {
    // Liveness probe for Docker/Coolify healthchecks and load balancers.
    // Party connections never reach this handler; every other path keeps the
    // default deny.
    const { pathname } = new URL(request.url)
    if (pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "healthy", service: "realtime" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
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
