import { render } from "preact";
import "./index.css";
import { LocaleProvider } from "./lib/i18n";
import { App } from "./app.tsx";
import { writeAppManifest } from "./lib/appManifest";
import { BUS_VERSION } from "./lib/sharedBus";

render(
  <LocaleProvider>
    <App />
  </LocaleProvider>,
  document.getElementById("app")!,
);

writeAppManifest({
  app: "tc-news",
  busVersion: BUS_VERSION,
  publishes: ["note-article"],
  consumes: [],
  reads: [],
});
