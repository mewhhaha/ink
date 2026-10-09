import { createRoot } from "react-dom/client";
import "@ink/react/styles.css";
import { App } from "./app.tsx";

createRoot(document.getElementById("root")!).render(<App />);
