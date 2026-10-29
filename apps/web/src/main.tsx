import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ThemeProvider, applyStoredTheme } from "./components/theme";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
applyStoredTheme();
createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
