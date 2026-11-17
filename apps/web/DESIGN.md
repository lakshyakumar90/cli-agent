# Agent web

The landing page helps developers understand the terminal agent, choose a provider,
and install from source. Documentation supports users and contributors with real
commands, source references, and explanatory diagrams. No public npm release is assumed.

Use a light workspace: canvas #f7f9fc, white #ffffff, ink #19242d, secondary #526273,
blue #305de8, pale blue #e9efff, mint #d8f3e5. Manrope carries the interface;
IBM Plex Mono is reserved for commands and code. Self-host font assets through npm.

The landing page pairs large left-aligned type with a working terminal scenario
selector. Below it, asymmetric feature sections explain real workflows rather than
repeating feature cards. The documentation uses a grouped left navigation, a readable
center column, and a restrained right table of contents. Mobile navigation uses a
disclosure, and wide code/diagrams scroll inside their own containers.

Inspiration: Vibrant's curated documentation and agent activity interfaces, and
OpenAI's task-first documentation hierarchy. Build original markup and assets;
do not copy screenshots, branding, testimonials, or product claims.

Keyboard focus must be visible. Search uses a native modal dialog. Every interactive
preview is labelled as an example. Respect reduced motion. Render Mermaid with strict
security, an accessible name, and readable source even when rendering fails.
# Stageshow redesign

The current direction uses warm paper (#f8f7f2), forest ink (#252b25), and olive (#4c633a). A centered editorial headline leads into a full-width terminal demonstration. One terminal window is the focal object; its lower/right edge bleeds beyond a masked Stage. A separate compact 358px composition keeps commands readable on phones. Explore, Build, and Review remain explicit interactive states, with no decorative autoplay or invented live activity.

Stageshow's static-card composition was the starting point: masked stage, purposeful crop, and a dominant product surface. Its terminal Window supplies the chrome. The host retains its own real controls and semantic heading hierarchy. The documentation uses quieter navigation, paper surfaces, readable code, and decision tables. CSS is layered in app/redesign.css over the shared base. Earlier design research below is retained as context, not the current palette specification.
