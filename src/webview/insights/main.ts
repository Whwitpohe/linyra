import "./insights.css";
import "../accents.css";
import { mountInsights, type InsightsApi } from "./view";

declare function acquireVsCodeApi(): InsightsApi;
mountInsights(acquireVsCodeApi());
