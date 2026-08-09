import ReactDOM from "react-dom/client";
import App from "./App";

// No StrictMode: its dev-only double-mounting spawns duplicate ptys.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
