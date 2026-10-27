import "./changes.css";
import "../accents.css";
import { mountChanges, type ChangesApi } from "./view";

declare function acquireVsCodeApi(): ChangesApi;
mountChanges(acquireVsCodeApi());
