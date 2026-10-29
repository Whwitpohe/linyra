import "./commit.css";
import "../accents.css";
import { mountCommit, type CommitApi } from "./view";

declare function acquireVsCodeApi(): CommitApi;
mountCommit(acquireVsCodeApi());
