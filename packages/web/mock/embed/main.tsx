import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { getResponse, HttpResponse } from "msw";
import OutreachPage from "../../src/pages/outreach/OutreachPage";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { GuardianTimestampProvider } from "../../src/components/guardian-timestamp-provider";
import { DashboardScaleProvider } from "../../src/hooks/use-preview-scale";
import { ThemeContext } from "../../src/hooks/theme-context";
import { DEFAULT_THEME_NAME, injectThemeCss, type ResolvedTheme } from "../../src/lib/theme";
import { queryClient } from "../../src/lib/query-client";
import "../../src/globals.css";
import "../../src/i18n";
import { outreachHandlers as handlers } from "../handlers/outreach";

// The Outreach pages without the dashboard shell, built as a script a host page
// loads directly, with no backend and no service worker. It mounts into the
// host's #rome-envoys element, starting at that element's data-route. The mock
// handlers answer /api fetches in the page, and routing lives in memory so the
// host URL never moves. The host steers it with window.postMessage
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
  const post = () => window.postMessage({ src: "rome-proto", route: location.pathname }, "*");
  useEffect(post, [location.pathname]);
  return null;
}

/** The host's mode: its <html data-theme>, else the system setting. */
function hostMode(): ResolvedTheme {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "light" || set === "dark") return set;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Follows the host's light or dark mode. The theme goes on <body> rather than
 *  <html>, which the host owns, and <body> also covers Radix portals. */
function HostTheme({ children }: { children: ReactNode }) {
  const [resolved, setResolved] = useState<ResolvedTheme>(hostMode);
  useEffect(() => {
    const sync = () => setResolved(hostMode());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      mq?.removeEventListener("change", sync);
    };
  }, []);
  useEffect(() => {
    document.body.setAttribute("data-theme", DEFAULT_THEME_NAME);
    document.body.classList.toggle("dark", resolved === "dark");
  }, [resolved]);
  const value = {
    preference: resolved,
    resolved,
    setPreference: () => {},
    theme: DEFAULT_THEME_NAME,
    setTheme: () => {},
    themes: [],
  };
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Re-declares the dashboard's :root tokens on <body>. Many of them alias a
 *  theme token, such as `--popover: var(--surface-elevated)`, and resolve where
 *  they are declared. The theme sits on <body>, so at <html> those aliases
 *  would resolve to nothing. */
function rehostRootTokens() {
  const copy = (rules: CSSRuleList): string =>
    Array.from(rules)
      .map((rule) => {
        if (rule instanceof CSSStyleRule) {
          return /(^|,)\s*:root\b/.test(rule.selectorText)
            ? `body[data-theme] { ${rule.style.cssText} }`
            : "";
        }
        if (rule instanceof CSSMediaRule) {
          const inner = copy(rule.cssRules);
          return inner && `@media ${rule.conditionText} { ${inner} }`;
        }
        if (rule instanceof CSSLayerBlockRule || rule instanceof CSSSupportsRule) {
          return copy(rule.cssRules);
        }
        return "";
      })
      .join("\n");
  const css = Array.from(document.styleSheets)
    .map((sheet) => {
      try {
        return copy(sheet.cssRules);
      } catch {
        return "";
      }
    })
    .join("\n");
  const style = document.createElement("style");
  style.id = "rome-envoys-tokens";
  style.textContent = css;
  document.head.appendChild(style);
}

injectThemeCss();
rehostRootTokens();
const mount = document.getElementById("rome-envoys")!;
const start = mount.dataset.route || "/outreach";

createRoot(mount).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[start]}>
        <Bridge />
        <DashboardScaleProvider>
          <HostTheme>
            <GuardianTimestampProvider>
              <TooltipProvider>
                <div className="bg-background text-foreground">
                  <Routes>
                    <Route path="/outreach/*" element={<OutreachPage />} />
                  </Routes>
                </div>
              </TooltipProvider>
            </GuardianTimestampProvider>
          </HostTheme>
        </DashboardScaleProvider>
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
