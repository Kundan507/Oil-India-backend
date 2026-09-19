# Oil India Tracker -- Backend (v5)

New in this version:
- Sites now have separate start point and end point coordinates
  (start_latitude/start_longitude, end_latitude/end_longitude) instead
  of a single location -- useful for pipeline-style projects that run
  between two physical places. The map draws a pin at each point plus
  a line connecting them.
- Fixed a bug where an invalid or malformed coordinate silently became
  null and the pin just disappeared with no explanation. Now the API
  returns a clear error message instead ("Start latitude must be a
  valid number").
- Admin can permanently delete a manager or engineer account
  (DELETE /users/:id). Tasks that were assigned to them are unassigned
  (not deleted), so the work history stays intact. Admins cannot
  delete their own account or another admin's account this way.
- Confirmed: GET /tasks already returns latestPhotoUrl regardless of
  a task's approval status, so the photo a manager/admin sees in
  Approval Center continues to show up in Project & Schedule even
  after the task is approved -- no backend change was needed for this,
  just a frontend display change.

## Coordinate fields, explained

POST /sites and PATCH /sites/:id now accept:
```
startLatitude, startLongitude   -- where the project begins
endLatitude, endLongitude       -- where the project ends
```
All four are optional. If you only have one location for a site (not
a start/end pair), you can fill in the same coordinates for both start
and end -- the map will just show a single pin with no visible line.

## Deleting a user

DELETE /users/:id (admin only):
- Cannot target your own account
- Cannot target another admin's account
- Unassigns (does not delete) any tasks that person had
- Removes their site assignments automatically
- Logs the deletion in the audit log

## Setup
Same as before:
```
npm install
cp .env.example .env
# fill in JWT_SECRET and the 3 SUPABASE_ values
npm run seed
npm start
```

Everything else (auth, roles, Supabase, reports, timeline status) is
unchanged from v4.
