-- Profile: the user changes their own name and password through the auth role. Changing
-- the password closes the user's other sessions (sessions already allow delete).

grant update (name, password_hash) on auth.users to gestionale_auth;
