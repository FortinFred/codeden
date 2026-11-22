/**
 * The server's view of the forge seam (`docs/forges.md` §4.2). The interface and every shape it
 * uses are contracts; this module is where server code will import them, so a GitHub or Forgejo
 * adapter can be swapped without touching a caller.
 */
export type {
  CreateForgeIssue,
  CreateForgePull,
  Forge,
  ForgeAttachment,
  ForgeCapabilities,
  ForgeChecksSummary,
  ForgeCompare,
  ForgeConnection,
  ForgeFileCommit,
  ForgeIssue,
  ForgeIssueDetails,
  ForgeIssueQuery,
  ForgePermission,
  ForgePr,
  ForgePrDetails,
  ForgePrDiff,
  ForgePrFile,
  ForgeProvider,
  ForgePutFile,
  ForgeRepo,
  ForgeRepoInfo,
  ForgeReview,
  ForgeUploadedAttachment,
  MergeForgePull,
  SubmitForgeReview,
  UpdateForgePull,
} from "@codeden/contracts";
export { ForgeError } from "../errors";
