-- Fixture E1-fix (#11): volcado MÍNIMO de una base TaxHacker PRE-E1.
-- Generado con las migraciones 20250403104933_init … 20250523104130_split_tx_items
-- (las diez heredadas de TaxHacker, antes de multi-tenant) más datos de dos
-- usuarios con código de categoría/proyecto SOLAPADO ('oficina', 'p1') y una
-- transacción cada uno. Incluye "_prisma_migrations" para que
-- `prisma migrate deploy` continúe por la primera migración de E1.
-- NO EDITAR A MANO: regenerar con scripts/… o repitiendo el procedimiento
-- descrito en docs/ESTADO.md.

--
-- PostgreSQL database dump
--

\restrict lkx4MUeJnwufRfeKHaqsudZs3a71JQA4zNd13GJO0nSupp4SMrTOO5mbbmuryGB

-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp(3) without time zone,
    refresh_token_expires_at timestamp(3) without time zone,
    scope text,
    password text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: app_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_data (
    id uuid NOT NULL,
    app text NOT NULL,
    user_id uuid NOT NULL,
    data jsonb NOT NULL
);


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#000000'::text NOT NULL,
    llm_prompt text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: currencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.currencies (
    id uuid NOT NULL,
    user_id uuid,
    code text NOT NULL,
    name text NOT NULL
);


--
-- Name: fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fields (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    type text DEFAULT 'string'::text NOT NULL,
    llm_prompt text,
    options jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_visible_in_list boolean DEFAULT false NOT NULL,
    is_visible_in_analysis boolean DEFAULT false NOT NULL,
    is_required boolean DEFAULT false NOT NULL,
    is_extra boolean DEFAULT true NOT NULL
);


--
-- Name: files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.files (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    filename text NOT NULL,
    path text NOT NULL,
    mimetype text NOT NULL,
    metadata jsonb,
    is_reviewed boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    cached_parse_result jsonb,
    is_splitted boolean DEFAULT false NOT NULL
);


--
-- Name: progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.progress (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    data jsonb,
    current integer DEFAULT 0 NOT NULL,
    total integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#000000'::text NOT NULL,
    llm_prompt text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    ip_address text,
    user_agent text,
    user_id uuid NOT NULL
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    value text
);


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text,
    description text,
    merchant text,
    total integer,
    currency_code text,
    converted_total integer,
    converted_currency_code text,
    type text DEFAULT 'expense'::text,
    note text,
    files jsonb DEFAULT '[]'::jsonb NOT NULL,
    extra jsonb,
    category_code text,
    project_code text,
    issued_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    text text,
    items jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    avatar text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    membership_plan text,
    membership_expires_at timestamp(3) without time zone,
    is_email_verified boolean DEFAULT false NOT NULL,
    storage_used integer DEFAULT 0 NOT NULL,
    storage_limit integer DEFAULT '-1'::integer NOT NULL,
    ai_balance integer DEFAULT 0 NOT NULL,
    stripe_customer_id text,
    business_address text,
    business_bank_details text,
    business_logo text,
    business_name text
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id uuid NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Data for Name: _prisma_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) FROM stdin;
63a082eb-07ff-4557-b510-fe89b8ff3edc	f9460a9f69ccc7a15b34fba6ee335a1c0123388f99d123d8d2bd1bcc6e36303a	2026-09-04 20:52:14.397662+00	20250403104933_init	\N	\N	2026-09-04 20:52:14.333715+00	1
a668b6aa-3bff-4765-a5e6-871b2deefdf0	c0c55fb45fd751d8a0789c037c6cb8206327c441c6686d3806fb389c2fffb69f	2026-09-04 20:52:14.401575+00	20250410130313_add_storage	\N	\N	2026-09-04 20:52:14.398333+00	1
f1c73106-531f-41f4-818c-410a18c275c7	37c9d7ee90e52ce6b4a3fb26bf1ba22e5278c59513b0c33c0db01eebb7f4f4be	2026-09-04 20:52:14.404529+00	20250421102306_token_limit	\N	\N	2026-09-04 20:52:14.402101+00	1
68711ff7-1fc8-44e0-873f-c49a7448e9ae	4c2a612c6ab8707d32979d3d457a2ae58088acb311ce3c6d952457ce9ff6db41	2026-09-04 20:52:14.407341+00	20250421113343_limits_not_null	\N	\N	2026-09-04 20:52:14.405131+00	1
19abbb85-9a72-4681-98ed-9a1aea99fb8f	fd78ad2fa97e33af7ec976ad5617930306dd2f95aada47fedff58270bf5ed649	2026-09-04 20:52:14.4103+00	20250424103453_stripe_customer_id	\N	\N	2026-09-04 20:52:14.407961+00	1
4935b969-668d-47c0-ba0d-0a4591a1b698	843e0c28d566f5c4673bab1f26fb581bc8bf7a9a1f29702c8223ae7a53c3d2c5	2026-09-04 20:52:14.412973+00	20250505101845_add_business_details	\N	\N	2026-09-04 20:52:14.410955+00	1
d3d1cda3-772a-4f89-b304-8ed0870d8f1d	3f06332cbcaaa8075ef5cde477cd85bc968ec7666a59adf6c9aeffce9d4c8b61	2026-09-04 20:52:14.419929+00	20250507100532_add_app_data	\N	\N	2026-09-04 20:52:14.413502+00	1
289abfd5-87b0-4873-88b8-cbe33d9e91c3	75e4965dc8c26c5fbeb57d4050011676db309c8cea479b493738de60b3626a15	2026-09-04 20:52:14.427464+00	20250519130610_progress	\N	\N	2026-09-04 20:52:14.420568+00	1
6d28c7e2-ece1-4ae6-9571-72eaea708fb8	f795bc4ca1c8eba478dc9a8cfa8cc761d95f3ab93ed70cf876e478f44e4b986b	2026-09-04 20:52:14.430193+00	20250520185247_add_cached_parse_result	\N	\N	2026-09-04 20:52:14.427956+00	1
0506c175-731d-4c5f-8aa4-a45e0693df7e	2559ff797928c339c278a3c8e3ff059f415ef748a0cc661d2f807be5bf7b43e3	2026-09-04 20:52:14.433516+00	20250523104130_split_tx_items	\N	\N	2026-09-04 20:52:14.430864+00	1
\.


--
-- Data for Name: account; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: app_data; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.app_data (id, app, user_id, data) FROM stdin;
c1c1c1c1-1111-4111-8111-111111111111	invoices	11111111-1111-4111-8111-111111111111	{}
c2c2c2c2-2222-4222-8222-222222222222	invoices	22222222-2222-4222-8222-222222222222	{}
\.


--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.categories (id, user_id, code, name, color, llm_prompt, created_at) FROM stdin;
aaaa1111-1111-4111-8111-111111111111	11111111-1111-4111-8111-111111111111	oficina	Oficina de Ana	#111111	\N	2026-09-04 20:52:32.785
bbbb2222-2222-4222-8222-222222222222	22222222-2222-4222-8222-222222222222	oficina	Oficina de Bruno	#222222	\N	2026-09-04 20:52:32.785
\.


--
-- Data for Name: currencies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.currencies (id, user_id, code, name) FROM stdin;
dddd1111-1111-4111-8111-111111111111	11111111-1111-4111-8111-111111111111	EUR	Euro
dddd2222-2222-4222-8222-222222222222	22222222-2222-4222-8222-222222222222	EUR	Euro
\.


--
-- Data for Name: fields; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fields (id, user_id, code, name, type, llm_prompt, options, created_at, is_visible_in_list, is_visible_in_analysis, is_required, is_extra) FROM stdin;
ffff1111-1111-4111-8111-111111111111	11111111-1111-4111-8111-111111111111	merchant	Proveedor	string	\N	\N	2026-09-04 20:52:32.789	f	f	f	t
ffff2222-2222-4222-8222-222222222222	22222222-2222-4222-8222-222222222222	merchant	Proveedor	string	\N	\N	2026-09-04 20:52:32.789	f	f	f	t
\.


--
-- Data for Name: files; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.files (id, user_id, filename, path, mimetype, metadata, is_reviewed, created_at, cached_parse_result, is_splitted) FROM stdin;
a1a1a1a1-1111-4111-8111-111111111111	11111111-1111-4111-8111-111111111111	ana.pdf	unsorted/ana.pdf	application/pdf	{}	f	2026-09-04 20:52:48.061	\N	f
a2a2a2a2-2222-4222-8222-222222222222	22222222-2222-4222-8222-222222222222	bruno.pdf	unsorted/bruno.pdf	application/pdf	{}	f	2026-09-04 20:52:48.061	\N	f
\.


--
-- Data for Name: progress; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.progress (id, user_id, type, data, current, total, created_at) FROM stdin;
\.


--
-- Data for Name: projects; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.projects (id, user_id, code, name, color, llm_prompt, created_at) FROM stdin;
cccc1111-1111-4111-8111-111111111111	11111111-1111-4111-8111-111111111111	p1	Proyecto de Ana	#111111	\N	2026-09-04 20:52:32.786
cccc2222-2222-4222-8222-222222222222	22222222-2222-4222-8222-222222222222	p1	Proyecto de Bruno	#222222	\N	2026-09-04 20:52:32.786
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sessions (id, token, expires_at, created_at, updated_at, ip_address, user_agent, user_id) FROM stdin;
\.


--
-- Data for Name: settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.settings (id, user_id, code, name, description, value) FROM stdin;
eeee1111-1111-4111-8111-111111111111	11111111-1111-4111-8111-111111111111	app_title	Título	\N	ERP de Ana
eeee2222-2222-4222-8222-222222222222	22222222-2222-4222-8222-222222222222	app_title	Título	\N	ERP de Bruno
\.


--
-- Data for Name: transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.transactions (id, user_id, name, description, merchant, total, currency_code, converted_total, converted_currency_code, type, note, files, extra, category_code, project_code, issued_at, created_at, updated_at, text, items) FROM stdin;
b1b1b1b1-1111-4111-8111-111111111111	11111111-1111-4111-8111-111111111111	Factura Ana	\N	Proveedor A	12100	EUR	\N	\N	expense	\N	[]	\N	oficina	p1	2026-09-04 20:52:48.066	2026-09-04 20:52:48.066	2026-09-04 20:52:48.066	\N	[]
b2b2b2b2-2222-4222-8222-222222222222	22222222-2222-4222-8222-222222222222	Factura Bruno	\N	Proveedor B	24200	EUR	\N	\N	expense	\N	[]	\N	oficina	p1	2026-09-04 20:52:48.066	2026-09-04 20:52:48.066	2026-09-04 20:52:48.066	\N	[]
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, email, name, avatar, created_at, updated_at, membership_plan, membership_expires_at, is_email_verified, storage_used, storage_limit, ai_balance, stripe_customer_id, business_address, business_bank_details, business_logo, business_name) FROM stdin;
11111111-1111-4111-8111-111111111111	ana@pre-e1.local	Ana	\N	2026-09-04 20:52:32.783	2026-09-04 20:52:32.783	unlimited	\N	f	1024	-1	10	cus_ana_pre_e1	\N	\N	\N	Ana SL
22222222-2222-4222-8222-222222222222	bruno@pre-e1.local	Bruno	\N	2026-09-04 20:52:32.783	2026-09-04 20:52:32.783	\N	\N	f	2048	-1	0	\N	\N	\N	\N	Bruno SLU
\.


--
-- Data for Name: verification; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.verification (id, identifier, value, expires_at, created_at, updated_at) FROM stdin;
\.


--
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: app_data app_data_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_data
    ADD CONSTRAINT app_data_pkey PRIMARY KEY (id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: currencies currencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currencies
    ADD CONSTRAINT currencies_pkey PRIMARY KEY (id);


--
-- Name: fields fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fields
    ADD CONSTRAINT fields_pkey PRIMARY KEY (id);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


--
-- Name: progress progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.progress
    ADD CONSTRAINT progress_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: app_data_user_id_app_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_data_user_id_app_key ON public.app_data USING btree (user_id, app);


--
-- Name: categories_user_id_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX categories_user_id_code_key ON public.categories USING btree (user_id, code);


--
-- Name: currencies_user_id_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX currencies_user_id_code_key ON public.currencies USING btree (user_id, code);


--
-- Name: fields_user_id_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fields_user_id_code_key ON public.fields USING btree (user_id, code);


--
-- Name: progress_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX progress_user_id_idx ON public.progress USING btree (user_id);


--
-- Name: projects_user_id_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX projects_user_id_code_key ON public.projects USING btree (user_id, code);


--
-- Name: sessions_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sessions_token_key ON public.sessions USING btree (token);


--
-- Name: settings_user_id_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX settings_user_id_code_key ON public.settings USING btree (user_id, code);


--
-- Name: transactions_category_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_category_code_idx ON public.transactions USING btree (category_code);


--
-- Name: transactions_issued_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_issued_at_idx ON public.transactions USING btree (issued_at);


--
-- Name: transactions_merchant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_merchant_idx ON public.transactions USING btree (merchant);


--
-- Name: transactions_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_name_idx ON public.transactions USING btree (name);


--
-- Name: transactions_project_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_project_code_idx ON public.transactions USING btree (project_code);


--
-- Name: transactions_total_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_total_idx ON public.transactions USING btree (total);


--
-- Name: transactions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_user_id_idx ON public.transactions USING btree (user_id);


--
-- Name: users_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);


--
-- Name: account account_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: app_data app_data_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_data
    ADD CONSTRAINT app_data_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: categories categories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: currencies currencies_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currencies
    ADD CONSTRAINT currencies_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: fields fields_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fields
    ADD CONSTRAINT fields_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: files files_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: progress progress_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.progress
    ADD CONSTRAINT progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: projects projects_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: settings settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: transactions transactions_category_code_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_category_code_user_id_fkey FOREIGN KEY (category_code, user_id) REFERENCES public.categories(code, user_id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transactions transactions_project_code_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_project_code_user_id_fkey FOREIGN KEY (project_code, user_id) REFERENCES public.projects(code, user_id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transactions transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict lkx4MUeJnwufRfeKHaqsudZs3a71JQA4zNd13GJO0nSupp4SMrTOO5mbbmuryGB

