export interface ProductVersions {
  ProductCode: string;
  LatestVersion: string;
  SupportedVersions: string[];
}

export interface RichText {
  Text: string;
  Html: string | null;
}

export interface OrgUnitInfo {
  Id: number;
  Type: { Id: number; Code: string; Name: string };
  Name: string;
  Code: string | null;
  HomeUrl?: string | null;
  ImageUrl?: string | null;
}

export interface MyOrgUnitInfo {
  OrgUnit: OrgUnitInfo;
  Access: {
    IsActive: boolean;
    StartDate: string | null;
    EndDate: string | null;
    CanAccess: boolean;
    ClasslistRoleName: string | null;
    LISRoles: string[];
    LastAccessed: string | null;
  };
  PinDate?: string | null;
}

export interface WhoAmI {
  Identifier: string;
  FirstName: string;
  LastName: string;
  UniqueName: string;
  ProfileIdentifier: string;
  Pronouns?: string;
}

/** D2L's SubmissionType enum for a dropbox folder. */
export enum SubmissionType {
  File = 0,
  Text = 1,
  OnPaper = 2,
  Observed = 3,
  FileOrText = 4,
}

export interface DropboxFolder {
  Id: number;
  CategoryId: number | null;
  Name: string;
  CustomInstructions?: RichText;
  Availability?: { StartDate: string | null; EndDate: string | null } | null;
  DueDate: string | null;
  DisplayInCalendar?: boolean;
  GroupTypeId: number | null;
  TotalFiles: number;
  UnreadFiles: number;
  FlaggedFiles: number;
  TotalUsers?: number;
  TotalUsersWithSubmissions?: number;
  TotalUsersWithFeedback?: number;
  Assessment?: { ScoreDenominator: number | null } | null;
  IsHidden: boolean;
  DropboxType?: number;
  SubmissionType?: SubmissionType;
}

export interface SubmissionFile {
  FileId: number;
  FileName: string;
  Size: number;
  IsRead?: boolean;
  IsFlagged?: boolean;
  IsDeleted?: boolean;
}

/** One actual submission event (what the student uploaded on one occasion). */
export interface DropboxSubmissionEntry {
  Id: number;
  SubmittedBy: { Identifier: string; DisplayName: string } | null;
  SubmissionDate: string;
  Comment: RichText | null;
  Files: SubmissionFile[];
}

export interface DropboxFeedback {
  Files: SubmissionFile[];
  Score: number | null;
  Feedback: RichText | null;
  IsGraded: boolean;
  GradedSymbol: string | null;
}

/**
 * The `mysubmissions` route doesn't return a flat submission list — each entry
 * is a per-student envelope (`Entity`/`Status`/`Feedback`) wrapping the actual
 * submission history in `Submissions[]`.
 */
export interface DropboxSubmission {
  Entity: { DisplayName: string; EntityId: number; EntityType: string; Active: boolean } | null;
  Status: number;
  Feedback: DropboxFeedback | null;
  Submissions: DropboxSubmissionEntry[];
  CompletionDate: string | null;
}

export interface GradeValue {
  DisplayedGrade: string | null;
  GradeObjectIdentifier: string;
  GradeObjectName: string;
  GradeObjectType: number;
  GradeObjectTypeName: string;
  PointsNumerator?: number | null;
  PointsDenominator?: number | null;
  WeightedNumerator?: number | null;
  WeightedDenominator?: number | null;
  Comments?: RichText | null;
  LastModified?: string | null;
}

export interface ContentModule {
  Id: number;
  Title: string;
  ShortTitle?: string | null;
  Type: number;
  Description?: RichText | null;
  ModuleStartDate?: string | null;
  ModuleEndDate?: string | null;
  ModuleDueDate?: string | null;
  IsHidden: boolean;
  Structure?: ContentObject[];
  Modules?: ContentModule[];
  Topics?: ContentTopic[];
}

export interface ContentTopic {
  Id: number;
  Title: string;
  ShortTitle?: string | null;
  Type: number;
  TopicType?: number;
  Url?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
  IsHidden: boolean;
  Description?: RichText | null;
}

/** A module's structure array mixes modules (Type 0) and topics (Type 1). */
export type ContentObject = ContentModule | ContentTopic;

export interface Forum {
  ForumId: number;
  Name: string;
  Description?: RichText | null;
  StartDate?: string | null;
  EndDate?: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
}

export interface DiscussionTopic {
  ForumId: number;
  TopicId: number;
  Name: string;
  Description?: RichText | null;
  StartDate?: string | null;
  EndDate?: string | null;
  UnlockStartDate?: string | null;
  UnlockEndDate?: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
  MustPostToParticipate?: boolean;
  ScoreOutOf?: number | null;
}

export interface DiscussionPost {
  ForumId: number;
  TopicId: number;
  PostId: number;
  ParentPostId: number | null;
  ThreadId: number;
  PostingUserId: number | null;
  /** Brightspace calls it this, not DisplayName. */
  PostingUserDisplayName?: string | null;
  DatePosted: string;
  LastEditDate?: string | null;
  Subject: string | null;
  Message: RichText;
  IsDeleted: boolean;
  IsRead?: boolean;
  RequiresApproval?: boolean;
  IsApproved?: boolean;
  IsAnonymous?: boolean;
  ThreadIsPinned?: boolean;
  WordCount?: number;
  AttachmentCount?: number;
  Attachments?: { FileId: number; FileName: string; Size: number }[];
  ReplyPostIds?: number[];
}

export interface NewsItem {
  Id: number;
  Title: string;
  Body: RichText;
  StartDate: string | null;
  EndDate: string | null;
  IsHidden: boolean;
  IsGlobal?: boolean;
  Attachments?: { FileId: number; FileName: string; Size: number }[];
}

export interface CalendarEvent {
  CalendarEventId: number;
  OrgUnitId: number;
  Title: string;
  Description?: string | null;
  StartDateTime: string | null;
  EndDateTime: string | null;
  IsAllDay?: boolean;
  Location?: string | null;
  AssociatedEntity?: {
    EntityType?: string | null;
    EntityId?: number | null;
  } | null;
}

/** Bookmark-paged responses used across lp/le. */
export interface PagedResult<T> {
  PagingInfo: { Bookmark: string | null; HasMoreItems: boolean };
  Items: T[];
}

/** Some routes use `Objects` instead of `Items`. */
export interface ObjectListPage<T> {
  PagingInfo: { Bookmark: string | null; HasMoreItems: boolean };
  Objects: T[];
}
