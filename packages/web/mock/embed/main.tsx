import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { getResponse, HttpResponse } from "msw";
import OutreachPage from "../../src/pages/outreach/OutreachPage";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { GuardianTimestampProvider } from "../../src/components/guardian-timestamp-provider";
import { DashboardScaleProvider } from "../../src/hooks/use-preview-scale";
import { ThemeProvider } from "../../src/hooks/use-theme";
import { injectThemeCss } from "../../src/lib/theme";
import { queryClient } from "../../src/lib/query-client";
import "../../src/globals.css";
import "../../src/i18n";
import { outreachHandlers as handlers } from "../handlers/outreach";

// The Outreach pages without the dashboard shell, built as a static page that
// runs inside another page's iframe with no backend and no service worker. The
// mock handlers answer /api fetches in the page, and routing lives in memory so
// the host URL never moves. The host steers it with postMessage
// {src:"rome-doc", cmd:"go", route} and hears back {src:"rome-proto", route} on
// every navigation. Build with
// `npx rsbuild build -c mock/embed/rsbuild.config.ts` from packages/web.

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(
    input instanceof Request ? input : new URL(String(input), window.location.href),
    init,
  );
  const url = new URL(request.url);
  if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) {
    const response = await getResponse(handlers, request);
    return (
      response ?? HttpResponse.json({ detail: "Not available in this preview" }, { status: 503 })
    );
  }
  return realFetch(input, init);
};

function Bridge() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { src?: string; cmd?: string; route?: string; theme?: string };
      if (data?.src !== "rome-doc") return;
      if (data.cmd === "go" && data.route) navigate(data.route);
      if (data.cmd === "ping") post();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });
  const post = () =>
    window.parent.postMessage({ src: "rome-proto", route: location.pathname }, "*");
  useEffect(post, [location.pathname]);
  return null;
}

injectThemeCss();
const start = window.location.hash.replace(/^#/, "") || "/outreach";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[start]}>
        <Bridge />
        <DashboardScaleProvider>
          <ThemeProvider>
            <GuardianTimestampProvider>
              <TooltipProvider>
                <main className="min-h-dvh bg-background text-foreground">
                  <Routes>
                    <Route path="/outreach/*" element={<OutreachPage />} />
                  </Routes>
                </main>
              </TooltipProvider>
            </GuardianTimestampProvider>
          </ThemeProvider>
        </DashboardScaleProvider>
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
