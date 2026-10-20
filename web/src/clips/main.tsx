import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./clips.css";
import ClipsApp from "./ClipsApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClipsApp />
  </StrictMode>,
);
