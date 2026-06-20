import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async () => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json(
      { ok: false, error: "Missing Supabase function environment" },
      { status: 500 },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { count, error } = await supabase
    .from("licenses")
    .select("id", { count: "exact", head: true });

  if (error) {
    return Response.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, license_count: count ?? 0 });
});
