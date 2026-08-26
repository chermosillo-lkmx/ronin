import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DesktopApp } from "./DesktopApp";
// Orden deliberado y no reordenable: tokens de Nocturne primero; styles.css después (define sus
// propios tokens por tema); el puente AL FINAL, porque tiene la misma especificidad que
// styles.css y gana el último. Ver la cabecera de theme-bridge.css antes de tocar esto.
import "./nocturne.css";
import "./styles.css";
import "./theme-bridge.css";
import "./screens.css";
import "./ronin-shell.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.roninDesktop ? <DesktopApp /> : <App />}
  </React.StrictMode>
);
