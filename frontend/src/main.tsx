import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { firebaseEnabled } from "./firebase";
import { AuthProvider } from "./auth";
import { AuthGate } from "./AuthGate";
import { ThemeProvider } from "./theme";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./index.css";

// With Firebase configured -> real Google auth + onboarding. Without it (tests/local) -> the
// legacy ?as= dev path, so the existing flow and Playwright suites keep working unchanged.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      {firebaseEnabled ? (
        <AuthProvider>
          <AuthGate />
        </AuthProvider>
      ) : (
        <App />
      )}
    </ThemeProvider>
  </React.StrictMode>,
);
