-- שימי לב: להחליף את כתובת הפרויקט אם מקימים עותק אחר
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$
declare s text;
begin
  select value into s from public.app_config where key = 'cron_secret';
  perform cron.schedule('gbwigs-bot-cron', '* * * * *',
    format($f$select net.http_post(
      url := 'https://ciukldoxjmzwnmpeulob.supabase.co/functions/v1/telegram-bot?action=cron',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', %L),
      body := '{}'::jsonb, timeout_milliseconds := 55000)$f$, s));
end $$;
