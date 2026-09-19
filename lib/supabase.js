// lib/supabase.js
//
// Handles uploading site photos to Supabase Storage instead of saving
// them on the server's own disk. This matters for deployment: most
// hosting platforms (Render, Railway free tiers) wipe local files on
// every restart/redeploy \u2014 Supabase Storage keeps them permanently
// and gives back a public URL that works from anywhere (website,
// mobile app, doesn't matter).

const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const BUCKET_NAME = "site-photos";

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    "\u26a0\ufe0f  SUPABASE_URL or SUPABASE_ANON_KEY is missing in .env \u2014 photo uploads will fail until this is set."
  );
}

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Uploads a single photo buffer to Supabase Storage and returns its
// public URL. `fileBuffer` and `mimeType` come straight from multer's
// in-memory storage (see the upload middleware in routes/tasks.js).
async function uploadSitePhoto(fileBuffer, originalName, mimeType) {
  if (!supabase) {
    throw new Error("Supabase Storage is not configured on the server (missing SUPABASE_URL / SUPABASE_ANON_KEY).");
  }

  const ext = originalName.includes(".") ? originalName.split(".").pop() : "jpg";
  const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, fileBuffer, { contentType: mimeType, upsert: false });

  if (error) {
    throw new Error(`Photo upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName);
  return data.publicUrl;
}

module.exports = { uploadSitePhoto };
