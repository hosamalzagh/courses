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

Branch roles are grants per employee, per branch. Multiple roles on one branch combine there only. A person can have one central identity and distinct memberships in several centers. Center sessions are bound to the center ID as well as a host-only cookie. The API loads membership and grants on every protected request so a revoked role takes effect on the next request. The last active center owner cannot be suspended or stripped of ownership; status and grant changes serialize on the central center row. A grant update commits the central grants version before the center database transaction commits; if the center commit fails, the version may advance without a grant change, which is a safe invalidation. A central version failure rolls the center grants back. The version is never left behind a committed grant change.

Accepting a one-use invitation sent to the exact email address verifies that central identity's email, including an existing identity that had not yet verified it. Login still requires an active membership. Center MFA is optional for every member, including owners: it starts disabled, can be enabled from account security with the current password and a TOTP code, and then challenges login in every center for that central identity. Enabling it shows eight one-use recovery codes once; they are stored as hashes and can replace the app code at login or when disabling MFA. Disabling it requires the password and a current TOTP or recovery code. A platform account cannot disable its required MFA from a center. A center backup restores its tenant database only. During restore, current active owner IDs are captured before the snapshot is applied and reconciled afterward so a later owner remains able to enter.

Only platform owners can create centers, retry provisioning, change the accepted domain, suspend/reactivate centers, or manage platform users. Support can read central operational status, never center data. Center owners and admins can invite staff, activate/suspend memberships, change branch grants, and edit center contact settings. Only a center owner can grant `center_owner` or invite a center admin. Audit entries are scoped to the whole center for owners/admins and to assigned branches for branch auditors.

Future instructor and student portals require separate record policies: an instructor sees only assigned groups, and a student sees only their own records. Neither portal is implemented in this foundation.
