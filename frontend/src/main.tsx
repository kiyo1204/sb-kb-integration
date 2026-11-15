import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./style.css";
import "./design-system.css";
import "./rehearsal-ui.css";
import "./researcher-ui.css";
import "./r05-analysis-ui.css";

document.documentElement.setAttribute("data-r05-analysis-ui", "");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
