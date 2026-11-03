import { boot } from "./ui";
import "./publisher.css";

boot().catch((e) => {
  document.getElementById("app")!.textContent = `Parcha couldn't start: ${(e as Error).message}`;
});
