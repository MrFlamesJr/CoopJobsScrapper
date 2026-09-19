import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import TooltipLayer from "./components/TooltipLayer.jsx";
import { installTruncationTitles } from "./truncationTitles.js";
import "./index.css";

// One document listener for the whole page, so any text the CSS ellipsises
// gets a native hint on hover without every component opting in.
installTruncationTitles();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
    <TooltipLayer />
  </StrictMode>,
);
