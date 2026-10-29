import "./aiSettings.css";
// Registers <vscode-checkbox> (VS Code Elements, MIT): the AI switch and "Use this profile", as the Repo List's boxes.
import "@vscode-elements/elements/dist/vscode-checkbox/index.js";
import { mountAiSettings, type AiSettingsApi } from "./view";

declare function acquireVsCodeApi(): AiSettingsApi;
mountAiSettings(acquireVsCodeApi());
