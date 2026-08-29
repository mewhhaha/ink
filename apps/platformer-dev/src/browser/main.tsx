import { createRoot } from "react-dom/client";
import { PlatformerDevelopment } from "./application.tsx";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("platformer development root is missing");
}
createRoot(container).render(<PlatformerDevelopment />);
