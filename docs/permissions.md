# Access boundaries

| Role | Landlord status | Landlord changes | All center branches | Assigned branch read | Assigned branch edit | Assigned branch audit | Center members/settings |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `platform_owner` | Yes | Yes | No | No | No | No | No |
| `platform_support` | Yes | No | No | No | No | No | No |
| `center_owner` | No | No | Yes | Yes | Yes | Yes | Yes |
| `center_admin` | No | No | Yes | Yes | Yes | Yes | Yes, except ownership |
| `branch_manager` | No | No | No | Yes | Yes | No | No |
| `branch_viewer` | No | No | No | Yes | No | No | No |
| `branch_auditor` | No | No | No | Yes | No | Yes | No |

Branch roles are grants per employee, per branch. Multiple roles on one branch combine there only. A person can have one central identity and distinct memberships in several centers. Center sessions are bound to the center ID as well as a host-only cookie. The API loads membership and grants on every protected request so a revoked role takes effect on the next request. The last active center owner cannot be suspended or stripped of ownership; status and grant changes serialize on the central center row, with that lock held until the center grant transaction commits. The two databases do not share an atomic transaction: if the center commit succeeds but the following central commit fails, the API reconnects and retries the central version increment. A persistent central outage may leave `grants_version` behind; authorization still reads the committed center grants on every request. After central recovery, the operator can run `courses:reconcile-grants <slug> --apply --invalidate-versions`. The version is not used as a permission cache key in this foundation.

Accepting a one-use invitation sent to the exact email address verifies that central identity's email, including an existing identity that had not yet verified it. Login still requires an active membership. Center MFA is optional for every member, including owners: it starts disabled, can be enabled from account security with the current password and a TOTP code, and then challenges login in every center for that central identity. Enabling it shows eight one-use recovery codes once; they are stored as hashes and can replace the app code at login or when disabling MFA. Disabling it requires the password and a current TOTP or recovery code. A platform account cannot disable its required MFA from a center. A center backup restores its tenant database only. During restore, current active owner IDs are captured before the snapshot is applied and reconciled afterward so a later owner remains able to enter.

Only platform owners can create centers, retry provisioning, change the accepted domain, suspend/reactivate centers, or manage platform users. Support can read central operational status, never center data. Center owners and admins can invite staff, activate/suspend memberships, change branch grants, and edit center contact settings. Only a center owner can grant `center_owner` or invite a center admin. Audit entries are scoped to the whole center for owners/admins and to assigned branches for branch auditors.

Central membership status and invitation changes write an audit outbox entry in the same central transaction. Delivery into the center audit log is idempotent; a failed delivery stays pending and is retried after five minutes by the scheduler or `courses:deliver-center-audit`. Later entries for other centers remain eligible. Branch, settings, and grant changes write their audit records in the same center transaction as the change.

Future instructor and student portals require separate record policies: an instructor sees only assigned groups, and a student sees only their own records. Neither portal is implemented in this foundation.

Educational records are deferred: each branch will own `Course → Stage → Level → Group → Session`, with independent groups and one-time copies of Course/Stage/Level into another branch. Attendance, exams, certificates, finance, registrations and their specialized roles are outside this pilot. No placeholder permissions or screens grant access to these future units.

User file uploads are also deferred. Development uses local storage; Cloudflare R2 remains an option when a real file feature is added. At that point, storage keys and signed access must be scoped to the center and prove that another center cannot read the file. No R2 credentials or upload interface are part of this pilot. The [README](../README.md) contains migration, isolated backup/restore and reconciliation commands.
