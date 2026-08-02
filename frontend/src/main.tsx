import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { firebaseEnabled } from "./firebase";
import { AuthProvider } from "./auth";
import { AuthGate } from "./AuthGate";
import { Privacy } from "./Privacy";
import { ThemeProvider } from "./theme";
import { usePath } from "./route";
import { Analytics } from "./analytics";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./index.css";

// With Firebase configured -> real Google auth + onboarding. Without it (tests/local) -> the
// legacy ?as= dev path, so the existing flow and Playwright suites keep working unchanged.
// /privacy is checked first: it's a public page that must render signed-out, and putting it
// above AuthProvider keeps it working even if auth is misconfigured or Firebase is down.
function Root() {
  const path = usePath();
  if (path === "/privacy") return <Privacy />;
  return firebaseEnabled ? (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  ) : (
    <App />
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Root />
      <Analytics />
    </ThemeProvider>
  </React.StrictMode>,
);
