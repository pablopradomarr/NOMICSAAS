-- E6 · T3 — Informes financieros: `report_runs`, `manual_review_flags` y
-- `accounts.cashflow_bucket`.
--
-- Diseño: docs/design/E6-informes.md §2.3 · ADR-0003 (informes derivados,
-- ReportRun, sello) · ADR-0012 (D1 presentación, D2 cashflowBucket, D3 umbrales)
-- · ADR-0009 (RLS estricta FORCE) · ADR-0010 (GRANT de columna).
--
-- Orden: enums → accounts (columna nueva, backfill, DROP de la vieja) → tablas
-- nuevas → RLS estricta → append-only → triggers → CHECKs → índices únicos
-- parciales. Todo en la MISMA transacción (el DDL de Postgres es transaccional),
-- que es lo que permite el patrón `NO FORCE` → backfill → `FORCE` del backfill.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enums nuevos
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "report_type" AS ENUM (
  'DIARIO','MAYOR','SUMAS_SALDOS','BALANCE','PYG','PYG_ANALITICA',
  'CASHFLOW_DIRECTO','CASHFLOW_INDIRECTO','PRESUPUESTO_REAL','DASHBOARD'
);
CREATE TYPE "seal"              AS ENUM ('VALIDADO_AUTOMATICAMENTE','REQUIERE_REVISION');
CREATE TYPE "result_kind"       AS ENUM ('FULL','SUMMARY');
CREATE TYPE "comparative_basis" AS ENUM (
  'SAME_PERIOD_PREVIOUS_YEAR','PREVIOUS_FISCAL_YEAR_CLOSE','PREVIOUS_PERIOD','NONE'
);
CREATE TYPE "cashflow_bucket" AS ENUM (
  'COBROS_CLIENTES','PAGOS_PROVEEDORES','PAGOS_PERSONAL','PAGOS_IMPUESTOS',
  'OTROS_EXPLOTACION','INVERSION','FINANCIACION'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `accounts`: `cashflow_category` → `cashflow_bucket` (ADR-0012 D2)
--
--    La columna vieja está a NULL en las 906 filas de todas las organizaciones
--    y no tiene un solo lector en el código: se sustituye, no se migra dato.
--    El backfill del bucket sale del seed y va LITERAL aquí (una migración no
--    lee ficheros). Sólo toca `origin = 'SEED'`: nunca pisa una cuenta que el
--    usuario haya creado a mano o importado por CSV.
--
--    Patrón obligatorio de CLAUDE.md: **marca primero** (runbook de E3, hallazgo
--    #7 de la ronda 1), después `NO FORCE` → backfill → `FORCE`.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "accounts" ADD COLUMN "cashflow_bucket" "cashflow_bucket";

DO $mig$
DECLARE
  v_marked boolean := COALESCE(obj_description(
    (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'accounts'), 'pg_class'
  ) LIKE '%cashflow_bucket:sembrado%', false);
  v_rows integer := 0;
BEGIN
  IF v_marked THEN
    RAISE NOTICE 'cashflow_bucket ya sembrado: no se toca ninguna fila';
    RETURN;
  END IF;

  -- 1. LA MARCA VA PRIMERO, en la misma transacción que el backfill.
  EXECUTE 'COMMENT ON TABLE "accounts" IS ' || quote_literal(
    'Plan de cuentas por organización. cashflow_bucket:sembrado — bucket de cashflow de la contrapartida, seeds/npgc.csv (E6, ADR-0012 D2).'
  );

  -- 2. Backfill bajo NO FORCE: con FORCE, el propietario tampoco esquiva la
  --    política y el UPDATE vería 0 filas (CLAUDE.md, ADR-0009).
  ALTER TABLE "accounts" NO FORCE ROW LEVEL SECURITY;

  UPDATE "accounts" a
     SET "cashflow_bucket" = seed.bucket::"cashflow_bucket"
    FROM (VALUES
      ('1','FINANCIACION'),
      ('10','FINANCIACION'),
      ('100','FINANCIACION'),
      ('101','FINANCIACION'),
      ('102','FINANCIACION'),
      ('103','FINANCIACION'),
      ('1030','FINANCIACION'),
      ('1034','FINANCIACION'),
      ('104','FINANCIACION'),
      ('1040','FINANCIACION'),
      ('1044','FINANCIACION'),
      ('108','FINANCIACION'),
      ('109','FINANCIACION'),
      ('11','FINANCIACION'),
      ('110','FINANCIACION'),
      ('111','FINANCIACION'),
      ('1110','FINANCIACION'),
      ('1111','FINANCIACION'),
      ('112','FINANCIACION'),
      ('113','FINANCIACION'),
      ('114','FINANCIACION'),
      ('1140','FINANCIACION'),
      ('1141','FINANCIACION'),
      ('1142','FINANCIACION'),
      ('1143','FINANCIACION'),
      ('1144','FINANCIACION'),
      ('115','FINANCIACION'),
      ('118','FINANCIACION'),
      ('119','FINANCIACION'),
      ('12','FINANCIACION'),
      ('120','FINANCIACION'),
      ('121','FINANCIACION'),
      ('129','FINANCIACION'),
      ('13','FINANCIACION'),
      ('130','FINANCIACION'),
      ('131','FINANCIACION'),
      ('132','FINANCIACION'),
      ('133','FINANCIACION'),
      ('134','FINANCIACION'),
      ('1340','FINANCIACION'),
      ('1341','FINANCIACION'),
      ('135','FINANCIACION'),
      ('136','FINANCIACION'),
      ('137','FINANCIACION'),
      ('1370','FINANCIACION'),
      ('1371','FINANCIACION'),
      ('14','FINANCIACION'),
      ('140','FINANCIACION'),
      ('141','FINANCIACION'),
      ('142','FINANCIACION'),
      ('143','FINANCIACION'),
      ('145','FINANCIACION'),
      ('146','FINANCIACION'),
      ('147','FINANCIACION'),
      ('15','FINANCIACION'),
      ('150','FINANCIACION'),
      ('153','FINANCIACION'),
      ('1533','FINANCIACION'),
      ('1534','FINANCIACION'),
      ('1535','FINANCIACION'),
      ('1536','FINANCIACION'),
      ('154','FINANCIACION'),
      ('1543','FINANCIACION'),
      ('1544','FINANCIACION'),
      ('1545','FINANCIACION'),
      ('1546','FINANCIACION'),
      ('16','FINANCIACION'),
      ('160','FINANCIACION'),
      ('1603','FINANCIACION'),
      ('1604','FINANCIACION'),
      ('1605','FINANCIACION'),
      ('161','FINANCIACION'),
      ('1613','FINANCIACION'),
      ('1614','FINANCIACION'),
      ('1615','FINANCIACION'),
      ('162','FINANCIACION'),
      ('1623','FINANCIACION'),
      ('1624','FINANCIACION'),
      ('1625','FINANCIACION'),
      ('163','FINANCIACION'),
      ('1633','FINANCIACION'),
      ('1634','FINANCIACION'),
      ('1635','FINANCIACION'),
      ('17','FINANCIACION'),
      ('170','FINANCIACION'),
      ('171','FINANCIACION'),
      ('172','FINANCIACION'),
      ('173','FINANCIACION'),
      ('174','FINANCIACION'),
      ('175','FINANCIACION'),
      ('176','FINANCIACION'),
      ('1765','FINANCIACION'),
      ('1768','FINANCIACION'),
      ('177','FINANCIACION'),
      ('178','FINANCIACION'),
      ('179','FINANCIACION'),
      ('18','FINANCIACION'),
      ('180','FINANCIACION'),
      ('181','FINANCIACION'),
      ('185','FINANCIACION'),
      ('189','FINANCIACION'),
      ('19','FINANCIACION'),
      ('190','FINANCIACION'),
      ('192','FINANCIACION'),
      ('194','FINANCIACION'),
      ('195','FINANCIACION'),
      ('197','FINANCIACION'),
      ('199','FINANCIACION'),
      ('2','INVERSION'),
      ('20','INVERSION'),
      ('200','INVERSION'),
      ('201','INVERSION'),
      ('202','INVERSION'),
      ('203','INVERSION'),
      ('204','INVERSION'),
      ('205','INVERSION'),
      ('206','INVERSION'),
      ('209','INVERSION'),
      ('21','INVERSION'),
      ('210','INVERSION'),
      ('211','INVERSION'),
      ('212','INVERSION'),
      ('213','INVERSION'),
      ('214','INVERSION'),
      ('215','INVERSION'),
      ('216','INVERSION'),
      ('217','INVERSION'),
      ('218','INVERSION'),
      ('219','INVERSION'),
      ('22','INVERSION'),
      ('220','INVERSION'),
      ('221','INVERSION'),
      ('23','INVERSION'),
      ('230','INVERSION'),
      ('231','INVERSION'),
      ('232','INVERSION'),
      ('233','INVERSION'),
      ('237','INVERSION'),
      ('239','INVERSION'),
      ('24','INVERSION'),
      ('240','INVERSION'),
      ('2403','INVERSION'),
      ('2404','INVERSION'),
      ('2405','INVERSION'),
      ('241','INVERSION'),
      ('2413','INVERSION'),
      ('2414','INVERSION'),
      ('2415','INVERSION'),
      ('242','INVERSION'),
      ('2423','INVERSION'),
      ('2424','INVERSION'),
      ('2425','INVERSION'),
      ('249','INVERSION'),
      ('2493','INVERSION'),
      ('2494','INVERSION'),
      ('2495','INVERSION'),
      ('25','INVERSION'),
      ('250','INVERSION'),
      ('251','INVERSION'),
      ('252','INVERSION'),
      ('253','INVERSION'),
      ('254','INVERSION'),
      ('255','INVERSION'),
      ('2550','INVERSION'),
      ('2553','INVERSION'),
      ('257','INVERSION'),
      ('258','INVERSION'),
      ('259','INVERSION'),
      ('26','INVERSION'),
      ('260','INVERSION'),
      ('265','INVERSION'),
      ('28','INVERSION'),
      ('280','INVERSION'),
      ('2800','INVERSION'),
      ('2801','INVERSION'),
      ('2802','INVERSION'),
      ('2803','INVERSION'),
      ('2804','INVERSION'),
      ('2805','INVERSION'),
      ('2806','INVERSION'),
      ('281','INVERSION'),
      ('2811','INVERSION'),
      ('2812','INVERSION'),
      ('2813','INVERSION'),
      ('2814','INVERSION'),
      ('2815','INVERSION'),
      ('2816','INVERSION'),
      ('2817','INVERSION'),
      ('2818','INVERSION'),
      ('2819','INVERSION'),
      ('282','INVERSION'),
      ('29','INVERSION'),
      ('290','INVERSION'),
      ('2900','INVERSION'),
      ('2901','INVERSION'),
      ('2902','INVERSION'),
      ('2903','INVERSION'),
      ('2905','INVERSION'),
      ('2906','INVERSION'),
      ('291','INVERSION'),
      ('2910','INVERSION'),
      ('2911','INVERSION'),
      ('2912','INVERSION'),
      ('2913','INVERSION'),
      ('2914','INVERSION'),
      ('2915','INVERSION'),
      ('2916','INVERSION'),
      ('2917','INVERSION'),
      ('2918','INVERSION'),
      ('2919','INVERSION'),
      ('292','INVERSION'),
      ('2920','INVERSION'),
      ('2921','INVERSION'),
      ('293','INVERSION'),
      ('2933','INVERSION'),
      ('2934','INVERSION'),
      ('2935','INVERSION'),
      ('294','INVERSION'),
      ('2943','INVERSION'),
      ('2944','INVERSION'),
      ('2945','INVERSION'),
      ('295','INVERSION'),
      ('2953','INVERSION'),
      ('2954','INVERSION'),
      ('2955','INVERSION'),
      ('296','INVERSION'),
      ('297','INVERSION'),
      ('298','INVERSION'),
      ('3','OTROS_EXPLOTACION'),
      ('30','OTROS_EXPLOTACION'),
      ('300','OTROS_EXPLOTACION'),
      ('301','OTROS_EXPLOTACION'),
      ('31','OTROS_EXPLOTACION'),
      ('310','OTROS_EXPLOTACION'),
      ('311','OTROS_EXPLOTACION'),
      ('32','OTROS_EXPLOTACION'),
      ('320','OTROS_EXPLOTACION'),
      ('321','OTROS_EXPLOTACION'),
      ('322','OTROS_EXPLOTACION'),
      ('325','OTROS_EXPLOTACION'),
      ('326','OTROS_EXPLOTACION'),
      ('327','OTROS_EXPLOTACION'),
      ('328','OTROS_EXPLOTACION'),
      ('33','OTROS_EXPLOTACION'),
      ('330','OTROS_EXPLOTACION'),
      ('331','OTROS_EXPLOTACION'),
      ('34','OTROS_EXPLOTACION'),
      ('340','OTROS_EXPLOTACION'),
      ('341','OTROS_EXPLOTACION'),
      ('35','OTROS_EXPLOTACION'),
      ('350','OTROS_EXPLOTACION'),
      ('351','OTROS_EXPLOTACION'),
      ('36','OTROS_EXPLOTACION'),
      ('360','OTROS_EXPLOTACION'),
      ('361','OTROS_EXPLOTACION'),
      ('365','OTROS_EXPLOTACION'),
      ('366','OTROS_EXPLOTACION'),
      ('368','OTROS_EXPLOTACION'),
      ('369','OTROS_EXPLOTACION'),
      ('39','OTROS_EXPLOTACION'),
      ('390','OTROS_EXPLOTACION'),
      ('391','OTROS_EXPLOTACION'),
      ('392','OTROS_EXPLOTACION'),
      ('393','OTROS_EXPLOTACION'),
      ('394','OTROS_EXPLOTACION'),
      ('395','OTROS_EXPLOTACION'),
      ('396','OTROS_EXPLOTACION'),
      ('40','PAGOS_PROVEEDORES'),
      ('400','PAGOS_PROVEEDORES'),
      ('4000','PAGOS_PROVEEDORES'),
      ('4004','PAGOS_PROVEEDORES'),
      ('4009','PAGOS_PROVEEDORES'),
      ('401','PAGOS_PROVEEDORES'),
      ('403','PAGOS_PROVEEDORES'),
      ('4030','PAGOS_PROVEEDORES'),
      ('4031','PAGOS_PROVEEDORES'),
      ('4034','PAGOS_PROVEEDORES'),
      ('4036','PAGOS_PROVEEDORES'),
      ('4039','PAGOS_PROVEEDORES'),
      ('404','PAGOS_PROVEEDORES'),
      ('405','PAGOS_PROVEEDORES'),
      ('406','PAGOS_PROVEEDORES'),
      ('407','PAGOS_PROVEEDORES'),
      ('41','PAGOS_PROVEEDORES'),
      ('410','PAGOS_PROVEEDORES'),
      ('4100','PAGOS_PROVEEDORES'),
      ('4104','PAGOS_PROVEEDORES'),
      ('4109','PAGOS_PROVEEDORES'),
      ('411','PAGOS_PROVEEDORES'),
      ('419','PAGOS_PROVEEDORES'),
      ('43','COBROS_CLIENTES'),
      ('430','COBROS_CLIENTES'),
      ('4300','COBROS_CLIENTES'),
      ('4304','COBROS_CLIENTES'),
      ('4309','COBROS_CLIENTES'),
      ('431','COBROS_CLIENTES'),
      ('4310','COBROS_CLIENTES'),
      ('4311','COBROS_CLIENTES'),
      ('4312','COBROS_CLIENTES'),
      ('4315','COBROS_CLIENTES'),
      ('432','COBROS_CLIENTES'),
      ('433','COBROS_CLIENTES'),
      ('4330','COBROS_CLIENTES'),
      ('4331','COBROS_CLIENTES'),
      ('4332','COBROS_CLIENTES'),
      ('4334','COBROS_CLIENTES'),
      ('4336','COBROS_CLIENTES'),
      ('4337','COBROS_CLIENTES'),
      ('4339','COBROS_CLIENTES'),
      ('434','COBROS_CLIENTES'),
      ('435','COBROS_CLIENTES'),
      ('436','COBROS_CLIENTES'),
      ('437','COBROS_CLIENTES'),
      ('438','COBROS_CLIENTES'),
      ('44','OTROS_EXPLOTACION'),
      ('440','OTROS_EXPLOTACION'),
      ('4400','OTROS_EXPLOTACION'),
      ('4404','OTROS_EXPLOTACION'),
      ('4409','OTROS_EXPLOTACION'),
      ('441','OTROS_EXPLOTACION'),
      ('4410','OTROS_EXPLOTACION'),
      ('4411','OTROS_EXPLOTACION'),
      ('4412','OTROS_EXPLOTACION'),
      ('4415','OTROS_EXPLOTACION'),
      ('446','OTROS_EXPLOTACION'),
      ('449','OTROS_EXPLOTACION'),
      ('46','OTROS_EXPLOTACION'),
      ('460','PAGOS_PERSONAL'),
      ('465','PAGOS_PERSONAL'),
      ('466','PAGOS_PERSONAL'),
      ('47','PAGOS_IMPUESTOS'),
      ('470','PAGOS_IMPUESTOS'),
      ('4700','PAGOS_IMPUESTOS'),
      ('4708','PAGOS_IMPUESTOS'),
      ('4709','PAGOS_IMPUESTOS'),
      ('471','PAGOS_PERSONAL'),
      ('472','PAGOS_IMPUESTOS'),
      ('473','PAGOS_IMPUESTOS'),
      ('474','PAGOS_IMPUESTOS'),
      ('4740','PAGOS_IMPUESTOS'),
      ('4742','PAGOS_IMPUESTOS'),
      ('4745','PAGOS_IMPUESTOS'),
      ('475','PAGOS_IMPUESTOS'),
      ('4750','PAGOS_IMPUESTOS'),
      ('4751','PAGOS_IMPUESTOS'),
      ('4752','PAGOS_IMPUESTOS'),
      ('4758','PAGOS_IMPUESTOS'),
      ('476','PAGOS_PERSONAL'),
      ('477','PAGOS_IMPUESTOS'),
      ('479','PAGOS_IMPUESTOS'),
      ('48','OTROS_EXPLOTACION'),
      ('480','OTROS_EXPLOTACION'),
      ('485','OTROS_EXPLOTACION'),
      ('49','OTROS_EXPLOTACION'),
      ('490','OTROS_EXPLOTACION'),
      ('493','OTROS_EXPLOTACION'),
      ('4933','OTROS_EXPLOTACION'),
      ('4934','OTROS_EXPLOTACION'),
      ('4935','OTROS_EXPLOTACION'),
      ('499','OTROS_EXPLOTACION'),
      ('4994','OTROS_EXPLOTACION'),
      ('4999','OTROS_EXPLOTACION'),
      ('50','FINANCIACION'),
      ('500','FINANCIACION'),
      ('501','FINANCIACION'),
      ('502','FINANCIACION'),
      ('505','FINANCIACION'),
      ('506','FINANCIACION'),
      ('507','FINANCIACION'),
      ('509','FINANCIACION'),
      ('5090','FINANCIACION'),
      ('5091','FINANCIACION'),
      ('5095','FINANCIACION'),
      ('51','FINANCIACION'),
      ('510','FINANCIACION'),
      ('5103','FINANCIACION'),
      ('5104','FINANCIACION'),
      ('5105','FINANCIACION'),
      ('511','FINANCIACION'),
      ('5113','FINANCIACION'),
      ('5114','FINANCIACION'),
      ('5115','FINANCIACION'),
      ('512','FINANCIACION'),
      ('5123','FINANCIACION'),
      ('5124','FINANCIACION'),
      ('5125','FINANCIACION'),
      ('513','FINANCIACION'),
      ('5133','FINANCIACION'),
      ('5134','FINANCIACION'),
      ('5135','FINANCIACION'),
      ('514','FINANCIACION'),
      ('5143','FINANCIACION'),
      ('5144','FINANCIACION'),
      ('5145','FINANCIACION'),
      ('52','FINANCIACION'),
      ('520','FINANCIACION'),
      ('5200','FINANCIACION'),
      ('5201','FINANCIACION'),
      ('5208','FINANCIACION'),
      ('5209','FINANCIACION'),
      ('521','FINANCIACION'),
      ('522','FINANCIACION'),
      ('523','FINANCIACION'),
      ('524','FINANCIACION'),
      ('525','FINANCIACION'),
      ('526','FINANCIACION'),
      ('527','FINANCIACION'),
      ('528','FINANCIACION'),
      ('529','FINANCIACION'),
      ('5290','FINANCIACION'),
      ('5291','FINANCIACION'),
      ('5292','FINANCIACION'),
      ('5293','FINANCIACION'),
      ('5295','FINANCIACION'),
      ('5296','FINANCIACION'),
      ('5297','FINANCIACION'),
      ('53','INVERSION'),
      ('530','INVERSION'),
      ('5303','INVERSION'),
      ('5304','INVERSION'),
      ('5305','INVERSION'),
      ('531','INVERSION'),
      ('5313','INVERSION'),
      ('5314','INVERSION'),
      ('5315','INVERSION'),
      ('532','INVERSION'),
      ('5323','INVERSION'),
      ('5324','INVERSION'),
      ('5325','INVERSION'),
      ('533','INVERSION'),
      ('5333','INVERSION'),
      ('5334','INVERSION'),
      ('5335','INVERSION'),
      ('534','INVERSION'),
      ('5343','INVERSION'),
      ('5344','INVERSION'),
      ('5345','INVERSION'),
      ('535','INVERSION'),
      ('5353','INVERSION'),
      ('5354','INVERSION'),
      ('5355','INVERSION'),
      ('539','INVERSION'),
      ('5393','INVERSION'),
      ('5394','INVERSION'),
      ('5395','INVERSION'),
      ('54','INVERSION'),
      ('540','INVERSION'),
      ('541','INVERSION'),
      ('542','INVERSION'),
      ('543','INVERSION'),
      ('544','INVERSION'),
      ('545','INVERSION'),
      ('546','INVERSION'),
      ('547','INVERSION'),
      ('548','INVERSION'),
      ('549','INVERSION'),
      ('55','OTROS_EXPLOTACION'),
      ('550','OTROS_EXPLOTACION'),
      ('551','OTROS_EXPLOTACION'),
      ('552','OTROS_EXPLOTACION'),
      ('5523','OTROS_EXPLOTACION'),
      ('5524','OTROS_EXPLOTACION'),
      ('5525','OTROS_EXPLOTACION'),
      ('553','OTROS_EXPLOTACION'),
      ('5530','OTROS_EXPLOTACION'),
      ('5531','OTROS_EXPLOTACION'),
      ('5532','OTROS_EXPLOTACION'),
      ('5533','OTROS_EXPLOTACION'),
      ('554','OTROS_EXPLOTACION'),
      ('555','OTROS_EXPLOTACION'),
      ('556','OTROS_EXPLOTACION'),
      ('5563','OTROS_EXPLOTACION'),
      ('5564','OTROS_EXPLOTACION'),
      ('5565','OTROS_EXPLOTACION'),
      ('5566','OTROS_EXPLOTACION'),
      ('557','OTROS_EXPLOTACION'),
      ('558','OTROS_EXPLOTACION'),
      ('5580','OTROS_EXPLOTACION'),
      ('5585','OTROS_EXPLOTACION'),
      ('559','OTROS_EXPLOTACION'),
      ('5590','OTROS_EXPLOTACION'),
      ('5593','OTROS_EXPLOTACION'),
      ('5595','OTROS_EXPLOTACION'),
      ('5598','OTROS_EXPLOTACION'),
      ('56','FINANCIACION'),
      ('560','FINANCIACION'),
      ('561','FINANCIACION'),
      ('565','FINANCIACION'),
      ('566','FINANCIACION'),
      ('567','FINANCIACION'),
      ('568','FINANCIACION'),
      ('569','FINANCIACION'),
      ('58','INVERSION'),
      ('580','INVERSION'),
      ('581','INVERSION'),
      ('582','INVERSION'),
      ('583','INVERSION'),
      ('584','INVERSION'),
      ('585','INVERSION'),
      ('586','INVERSION'),
      ('587','INVERSION'),
      ('588','INVERSION'),
      ('589','INVERSION'),
      ('59','INVERSION'),
      ('593','INVERSION'),
      ('5933','INVERSION'),
      ('5934','INVERSION'),
      ('5935','INVERSION'),
      ('594','INVERSION'),
      ('5943','INVERSION'),
      ('5944','INVERSION'),
      ('5945','INVERSION'),
      ('595','INVERSION'),
      ('5953','INVERSION'),
      ('5954','INVERSION'),
      ('5955','INVERSION'),
      ('596','INVERSION'),
      ('597','INVERSION'),
      ('598','INVERSION'),
      ('599','INVERSION'),
      ('5990','INVERSION'),
      ('5991','INVERSION'),
      ('5992','INVERSION'),
      ('5993','INVERSION'),
      ('5994','INVERSION'),
      ('6','OTROS_EXPLOTACION'),
      ('60','OTROS_EXPLOTACION'),
      ('600','OTROS_EXPLOTACION'),
      ('601','OTROS_EXPLOTACION'),
      ('602','OTROS_EXPLOTACION'),
      ('606','OTROS_EXPLOTACION'),
      ('6060','OTROS_EXPLOTACION'),
      ('6061','OTROS_EXPLOTACION'),
      ('6062','OTROS_EXPLOTACION'),
      ('607','OTROS_EXPLOTACION'),
      ('608','OTROS_EXPLOTACION'),
      ('6080','OTROS_EXPLOTACION'),
      ('6081','OTROS_EXPLOTACION'),
      ('6082','OTROS_EXPLOTACION'),
      ('609','OTROS_EXPLOTACION'),
      ('6090','OTROS_EXPLOTACION'),
      ('6091','OTROS_EXPLOTACION'),
      ('6092','OTROS_EXPLOTACION'),
      ('61','OTROS_EXPLOTACION'),
      ('610','OTROS_EXPLOTACION'),
      ('611','OTROS_EXPLOTACION'),
      ('612','OTROS_EXPLOTACION'),
      ('62','OTROS_EXPLOTACION'),
      ('620','OTROS_EXPLOTACION'),
      ('621','OTROS_EXPLOTACION'),
      ('622','OTROS_EXPLOTACION'),
      ('623','OTROS_EXPLOTACION'),
      ('624','OTROS_EXPLOTACION'),
      ('625','OTROS_EXPLOTACION'),
      ('626','OTROS_EXPLOTACION'),
      ('627','OTROS_EXPLOTACION'),
      ('628','OTROS_EXPLOTACION'),
      ('629','OTROS_EXPLOTACION'),
      ('63','OTROS_EXPLOTACION'),
      ('630','OTROS_EXPLOTACION'),
      ('6300','OTROS_EXPLOTACION'),
      ('6301','OTROS_EXPLOTACION'),
      ('631','OTROS_EXPLOTACION'),
      ('633','OTROS_EXPLOTACION'),
      ('634','OTROS_EXPLOTACION'),
      ('6341','OTROS_EXPLOTACION'),
      ('6342','OTROS_EXPLOTACION'),
      ('636','OTROS_EXPLOTACION'),
      ('638','OTROS_EXPLOTACION'),
      ('639','OTROS_EXPLOTACION'),
      ('6391','OTROS_EXPLOTACION'),
      ('6392','OTROS_EXPLOTACION'),
      ('64','OTROS_EXPLOTACION'),
      ('640','OTROS_EXPLOTACION'),
      ('641','OTROS_EXPLOTACION'),
      ('642','OTROS_EXPLOTACION'),
      ('643','OTROS_EXPLOTACION'),
      ('644','OTROS_EXPLOTACION'),
      ('6440','OTROS_EXPLOTACION'),
      ('6442','OTROS_EXPLOTACION'),
      ('645','OTROS_EXPLOTACION'),
      ('6450','OTROS_EXPLOTACION'),
      ('6457','OTROS_EXPLOTACION'),
      ('649','OTROS_EXPLOTACION'),
      ('65','OTROS_EXPLOTACION'),
      ('650','OTROS_EXPLOTACION'),
      ('651','OTROS_EXPLOTACION'),
      ('6510','OTROS_EXPLOTACION'),
      ('6511','OTROS_EXPLOTACION'),
      ('659','OTROS_EXPLOTACION'),
      ('66','OTROS_EXPLOTACION'),
      ('660','OTROS_EXPLOTACION'),
      ('661','OTROS_EXPLOTACION'),
      ('6610','OTROS_EXPLOTACION'),
      ('6611','OTROS_EXPLOTACION'),
      ('6612','OTROS_EXPLOTACION'),
      ('6613','OTROS_EXPLOTACION'),
      ('6615','OTROS_EXPLOTACION'),
      ('6616','OTROS_EXPLOTACION'),
      ('6617','OTROS_EXPLOTACION'),
      ('6618','OTROS_EXPLOTACION'),
      ('662','OTROS_EXPLOTACION'),
      ('6620','OTROS_EXPLOTACION'),
      ('6621','OTROS_EXPLOTACION'),
      ('6622','OTROS_EXPLOTACION'),
      ('6623','OTROS_EXPLOTACION'),
      ('6624','OTROS_EXPLOTACION'),
      ('663','OTROS_EXPLOTACION'),
      ('6630','OTROS_EXPLOTACION'),
      ('6631','OTROS_EXPLOTACION'),
      ('6632','OTROS_EXPLOTACION'),
      ('6633','OTROS_EXPLOTACION'),
      ('664','OTROS_EXPLOTACION'),
      ('6640','OTROS_EXPLOTACION'),
      ('6641','OTROS_EXPLOTACION'),
      ('6642','OTROS_EXPLOTACION'),
      ('6643','OTROS_EXPLOTACION'),
      ('665','OTROS_EXPLOTACION'),
      ('6650','OTROS_EXPLOTACION'),
      ('6651','OTROS_EXPLOTACION'),
      ('6652','OTROS_EXPLOTACION'),
      ('6653','OTROS_EXPLOTACION'),
      ('6654','OTROS_EXPLOTACION'),
      ('6655','OTROS_EXPLOTACION'),
      ('6656','OTROS_EXPLOTACION'),
      ('6657','OTROS_EXPLOTACION'),
      ('666','OTROS_EXPLOTACION'),
      ('6660','OTROS_EXPLOTACION'),
      ('6661','OTROS_EXPLOTACION'),
      ('6662','OTROS_EXPLOTACION'),
      ('6663','OTROS_EXPLOTACION'),
      ('6665','OTROS_EXPLOTACION'),
      ('6666','OTROS_EXPLOTACION'),
      ('6667','OTROS_EXPLOTACION'),
      ('6668','OTROS_EXPLOTACION'),
      ('667','OTROS_EXPLOTACION'),
      ('6670','OTROS_EXPLOTACION'),
      ('6671','OTROS_EXPLOTACION'),
      ('6672','OTROS_EXPLOTACION'),
      ('6673','OTROS_EXPLOTACION'),
      ('6675','OTROS_EXPLOTACION'),
      ('6676','OTROS_EXPLOTACION'),
      ('6677','OTROS_EXPLOTACION'),
      ('6678','OTROS_EXPLOTACION'),
      ('668','OTROS_EXPLOTACION'),
      ('669','OTROS_EXPLOTACION'),
      ('67','OTROS_EXPLOTACION'),
      ('670','OTROS_EXPLOTACION'),
      ('671','OTROS_EXPLOTACION'),
      ('672','OTROS_EXPLOTACION'),
      ('673','OTROS_EXPLOTACION'),
      ('6733','OTROS_EXPLOTACION'),
      ('6734','OTROS_EXPLOTACION'),
      ('6735','OTROS_EXPLOTACION'),
      ('675','OTROS_EXPLOTACION'),
      ('678','OTROS_EXPLOTACION'),
      ('68','OTROS_EXPLOTACION'),
      ('680','OTROS_EXPLOTACION'),
      ('681','OTROS_EXPLOTACION'),
      ('682','OTROS_EXPLOTACION'),
      ('69','OTROS_EXPLOTACION'),
      ('690','OTROS_EXPLOTACION'),
      ('691','OTROS_EXPLOTACION'),
      ('692','OTROS_EXPLOTACION'),
      ('693','OTROS_EXPLOTACION'),
      ('6930','OTROS_EXPLOTACION'),
      ('6931','OTROS_EXPLOTACION'),
      ('6932','OTROS_EXPLOTACION'),
      ('6933','OTROS_EXPLOTACION'),
      ('694','OTROS_EXPLOTACION'),
      ('695','OTROS_EXPLOTACION'),
      ('6954','OTROS_EXPLOTACION'),
      ('6959','OTROS_EXPLOTACION'),
      ('696','OTROS_EXPLOTACION'),
      ('6960','OTROS_EXPLOTACION'),
      ('6961','OTROS_EXPLOTACION'),
      ('6962','OTROS_EXPLOTACION'),
      ('6963','OTROS_EXPLOTACION'),
      ('6965','OTROS_EXPLOTACION'),
      ('6966','OTROS_EXPLOTACION'),
      ('6967','OTROS_EXPLOTACION'),
      ('6968','OTROS_EXPLOTACION'),
      ('697','OTROS_EXPLOTACION'),
      ('6970','OTROS_EXPLOTACION'),
      ('6971','OTROS_EXPLOTACION'),
      ('6972','OTROS_EXPLOTACION'),
      ('6973','OTROS_EXPLOTACION'),
      ('698','OTROS_EXPLOTACION'),
      ('6980','OTROS_EXPLOTACION'),
      ('6981','OTROS_EXPLOTACION'),
      ('6985','OTROS_EXPLOTACION'),
      ('6986','OTROS_EXPLOTACION'),
      ('6987','OTROS_EXPLOTACION'),
      ('6988','OTROS_EXPLOTACION'),
      ('699','OTROS_EXPLOTACION'),
      ('6990','OTROS_EXPLOTACION'),
      ('6991','OTROS_EXPLOTACION'),
      ('6992','OTROS_EXPLOTACION'),
      ('6993','OTROS_EXPLOTACION'),
      ('7','OTROS_EXPLOTACION'),
      ('70','OTROS_EXPLOTACION'),
      ('700','OTROS_EXPLOTACION'),
      ('701','OTROS_EXPLOTACION'),
      ('702','OTROS_EXPLOTACION'),
      ('703','OTROS_EXPLOTACION'),
      ('704','OTROS_EXPLOTACION'),
      ('705','OTROS_EXPLOTACION'),
      ('706','OTROS_EXPLOTACION'),
      ('7060','OTROS_EXPLOTACION'),
      ('7061','OTROS_EXPLOTACION'),
      ('7062','OTROS_EXPLOTACION'),
      ('7063','OTROS_EXPLOTACION'),
      ('7064','OTROS_EXPLOTACION'),
      ('708','OTROS_EXPLOTACION'),
      ('7080','OTROS_EXPLOTACION'),
      ('7081','OTROS_EXPLOTACION'),
      ('7082','OTROS_EXPLOTACION'),
      ('7083','OTROS_EXPLOTACION'),
      ('7084','OTROS_EXPLOTACION'),
      ('709','OTROS_EXPLOTACION'),
      ('7090','OTROS_EXPLOTACION'),
      ('7091','OTROS_EXPLOTACION'),
      ('7092','OTROS_EXPLOTACION'),
      ('7093','OTROS_EXPLOTACION'),
      ('7094','OTROS_EXPLOTACION'),
      ('71','OTROS_EXPLOTACION'),
      ('710','OTROS_EXPLOTACION'),
      ('711','OTROS_EXPLOTACION'),
      ('712','OTROS_EXPLOTACION'),
      ('713','OTROS_EXPLOTACION'),
      ('73','OTROS_EXPLOTACION'),
      ('730','OTROS_EXPLOTACION'),
      ('731','OTROS_EXPLOTACION'),
      ('732','OTROS_EXPLOTACION'),
      ('733','OTROS_EXPLOTACION'),
      ('74','OTROS_EXPLOTACION'),
      ('740','OTROS_EXPLOTACION'),
      ('746','OTROS_EXPLOTACION'),
      ('747','OTROS_EXPLOTACION'),
      ('75','OTROS_EXPLOTACION'),
      ('751','OTROS_EXPLOTACION'),
      ('7510','OTROS_EXPLOTACION'),
      ('7511','OTROS_EXPLOTACION'),
      ('752','OTROS_EXPLOTACION'),
      ('753','OTROS_EXPLOTACION'),
      ('754','OTROS_EXPLOTACION'),
      ('755','OTROS_EXPLOTACION'),
      ('759','OTROS_EXPLOTACION'),
      ('76','OTROS_EXPLOTACION'),
      ('760','OTROS_EXPLOTACION'),
      ('7600','OTROS_EXPLOTACION'),
      ('7601','OTROS_EXPLOTACION'),
      ('7602','OTROS_EXPLOTACION'),
      ('7603','OTROS_EXPLOTACION'),
      ('761','OTROS_EXPLOTACION'),
      ('7610','OTROS_EXPLOTACION'),
      ('7611','OTROS_EXPLOTACION'),
      ('7612','OTROS_EXPLOTACION'),
      ('7613','OTROS_EXPLOTACION'),
      ('762','OTROS_EXPLOTACION'),
      ('7620','OTROS_EXPLOTACION'),
      ('7621','OTROS_EXPLOTACION'),
      ('763','OTROS_EXPLOTACION'),
      ('7630','OTROS_EXPLOTACION'),
      ('7631','OTROS_EXPLOTACION'),
      ('7632','OTROS_EXPLOTACION'),
      ('7633','OTROS_EXPLOTACION'),
      ('766','OTROS_EXPLOTACION'),
      ('7660','OTROS_EXPLOTACION'),
      ('7661','OTROS_EXPLOTACION'),
      ('7662','OTROS_EXPLOTACION'),
      ('7663','OTROS_EXPLOTACION'),
      ('7665','OTROS_EXPLOTACION'),
      ('7666','OTROS_EXPLOTACION'),
      ('7667','OTROS_EXPLOTACION'),
      ('7668','OTROS_EXPLOTACION'),
      ('767','OTROS_EXPLOTACION'),
      ('768','OTROS_EXPLOTACION'),
      ('769','OTROS_EXPLOTACION'),
      ('77','OTROS_EXPLOTACION'),
      ('770','OTROS_EXPLOTACION'),
      ('771','OTROS_EXPLOTACION'),
      ('772','OTROS_EXPLOTACION'),
      ('773','OTROS_EXPLOTACION'),
      ('7733','OTROS_EXPLOTACION'),
      ('7734','OTROS_EXPLOTACION'),
      ('7735','OTROS_EXPLOTACION'),
      ('774','OTROS_EXPLOTACION'),
      ('775','OTROS_EXPLOTACION'),
      ('778','OTROS_EXPLOTACION'),
      ('79','OTROS_EXPLOTACION'),
      ('790','OTROS_EXPLOTACION'),
      ('791','OTROS_EXPLOTACION'),
      ('792','OTROS_EXPLOTACION'),
      ('793','OTROS_EXPLOTACION'),
      ('7930','OTROS_EXPLOTACION'),
      ('7931','OTROS_EXPLOTACION'),
      ('7932','OTROS_EXPLOTACION'),
      ('7933','OTROS_EXPLOTACION'),
      ('794','OTROS_EXPLOTACION'),
      ('795','OTROS_EXPLOTACION'),
      ('7950','OTROS_EXPLOTACION'),
      ('7951','OTROS_EXPLOTACION'),
      ('7952','OTROS_EXPLOTACION'),
      ('7954','OTROS_EXPLOTACION'),
      ('7955','OTROS_EXPLOTACION'),
      ('7956','OTROS_EXPLOTACION'),
      ('7957','OTROS_EXPLOTACION'),
      ('796','OTROS_EXPLOTACION'),
      ('7960','OTROS_EXPLOTACION'),
      ('7961','OTROS_EXPLOTACION'),
      ('7962','OTROS_EXPLOTACION'),
      ('7963','OTROS_EXPLOTACION'),
      ('7965','OTROS_EXPLOTACION'),
      ('7966','OTROS_EXPLOTACION'),
      ('7967','OTROS_EXPLOTACION'),
      ('7968','OTROS_EXPLOTACION'),
      ('797','OTROS_EXPLOTACION'),
      ('7970','OTROS_EXPLOTACION'),
      ('7971','OTROS_EXPLOTACION'),
      ('7972','OTROS_EXPLOTACION'),
      ('7973','OTROS_EXPLOTACION'),
      ('798','OTROS_EXPLOTACION'),
      ('7980','OTROS_EXPLOTACION'),
      ('7981','OTROS_EXPLOTACION'),
      ('7985','OTROS_EXPLOTACION'),
      ('7986','OTROS_EXPLOTACION'),
      ('7987','OTROS_EXPLOTACION'),
      ('7988','OTROS_EXPLOTACION'),
      ('799','OTROS_EXPLOTACION'),
      ('7990','OTROS_EXPLOTACION'),
      ('7991','OTROS_EXPLOTACION'),
      ('7992','OTROS_EXPLOTACION'),
      ('7993','OTROS_EXPLOTACION')
    ) AS seed(code, bucket)
   WHERE a."code" = seed.code
     AND a."origin" = 'SEED'
     AND a."cashflow_bucket" IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;
  RAISE NOTICE 'cashflow_bucket: % fila(s) sembradas desde seeds/npgc.csv', v_rows;
END $mig$;

-- La columna vieja se va con su tipo: NULL en el 100 % de las filas, sin lectores.
ALTER TABLE "accounts" DROP COLUMN "cashflow_category";
DROP TYPE "cashflow_category";

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Tablas nuevas
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "report_runs" (
  "id"                 uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"    uuid         NOT NULL,
  "type"               "report_type" NOT NULL,
  "period_start"       date         NOT NULL,
  "period_end"         date         NOT NULL,
  "fiscal_year_id"     uuid,
  "params"             jsonb        NOT NULL,
  "params_hash"        char(64)     NOT NULL,
  "ledger_hash"        char(64)     NOT NULL,
  "analytics_hash"     char(64),
  "margin_config_hash" char(64),
  "allocation_run_id"  uuid,
  "analytics_key"      varchar(210) NOT NULL DEFAULT '∅',
  "git_sha"            varchar(64)  NOT NULL,
  "result"             jsonb        NOT NULL,
  "result_kind"        "result_kind" NOT NULL DEFAULT 'FULL',
  "provenance"         jsonb        NOT NULL,
  "validation"         jsonb        NOT NULL,
  "seal"               "seal"       NOT NULL,
  "seal_reasons"       jsonb        NOT NULL DEFAULT '[]',
  "duration_ms"        integer      NOT NULL,
  "comparative_run_id" uuid,
  "comparative_basis"  "comparative_basis",
  "created_by_id"      uuid,
  "created_at"         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "report_runs"
  ADD CONSTRAINT "report_runs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Coherencia analítica: un informe que DEPENDE de la analítica no puede
-- guardarse sin su sello (§2.3 punto 7).
ALTER TABLE "report_runs"
  ADD CONSTRAINT "report_runs_analytics_required"
    CHECK ("type" NOT IN ('PYG_ANALITICA','PRESUPUESTO_REAL','DASHBOARD') OR "analytics_hash" IS NOT NULL),
  ADD CONSTRAINT "report_runs_period"      CHECK ("period_end" >= "period_start"),
  ADD CONSTRAINT "report_runs_duration"    CHECK ("duration_ms" >= 0),
  -- R5: cota dura al tamaño del `result` (1 MB). `resultKind = SUMMARY` en
  -- DIARIO/MAYOR/SUMAS_SALDOS existe justo para no acercarse a ella (D-E6-4).
  ADD CONSTRAINT "report_runs_result_size" CHECK (pg_column_size("result") <= 1048576);

CREATE UNIQUE INDEX "report_runs_cache_key"
  ON "report_runs" ("organization_id","type","period_start","period_end","params_hash","ledger_hash","analytics_key","git_sha");
CREATE INDEX "report_runs_org_type_period_created_idx"
  ON "report_runs" ("organization_id","type","period_start","period_end","created_at" DESC);
CREATE INDEX "report_runs_org_type_ledger_idx"
  ON "report_runs" ("organization_id","type","ledger_hash");

CREATE TABLE "manual_review_flags" (
  "id"              uuid          NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid          NOT NULL,
  "period_start"    date          NOT NULL,
  "period_end"      date          NOT NULL,
  "scope"           "report_type",
  "reason"          varchar(1000) NOT NULL,
  "created_by_id"   uuid          NOT NULL,
  "created_at"      timestamp(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cleared_at"      timestamp(3),
  "cleared_by_id"   uuid,
  "clear_reason"    varchar(1000),
  CONSTRAINT "manual_review_flags_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "manual_review_flags"
  ADD CONSTRAINT "manual_review_flags_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "manual_review_flags"
  ADD CONSTRAINT "manual_review_flags_period" CHECK ("period_end" >= "period_start"),
  ADD CONSTRAINT "manual_review_flags_reason" CHECK (length(btrim("reason")) >= 10),
  -- Limpiar es un acto con autor y motivo: las tres columnas van juntas o ninguna.
  ADD CONSTRAINT "manual_review_flags_clear_complete"
    CHECK (("cleared_at" IS NULL AND "cleared_by_id" IS NULL AND "clear_reason" IS NULL)
        OR ("cleared_at" IS NOT NULL AND "cleared_by_id" IS NOT NULL
            AND "clear_reason" IS NOT NULL AND length(btrim("clear_reason")) >= 10));

CREATE INDEX "manual_review_flags_org_period_idx"
  ON "manual_review_flags" ("organization_id","period_start","period_end");

-- §2.3 punto 5 — UN solo flag activo por periodo y ámbito. Dos índices parciales
-- porque en PostgreSQL `NULL <> NULL` y un único índice con `scope` nullable
-- dejaría meter infinitos flags de ámbito global sobre el mismo periodo.
CREATE UNIQUE INDEX "manual_review_flags_active_scoped"
  ON "manual_review_flags" ("organization_id","period_start","period_end","scope")
  WHERE "cleared_at" IS NULL AND "scope" IS NOT NULL;
CREATE UNIQUE INDEX "manual_review_flags_active_global"
  ON "manual_review_flags" ("organization_id","period_start","period_end")
  WHERE "cleared_at" IS NULL AND "scope" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS estricta (ADR-0009) sobre las dos tablas nuevas
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_runs','manual_review_flags'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. `report_runs` APPEND-ONLY, con las dos cerraduras (patrón `audit_logs`)
--
--    Un informe sellado es un HECHO fechado: si se pudiera editar, el sello no
--    acreditaría nada. I-E6-16 comprueba que `UPDATE`/`DELETE` como app_runtime
--    devuelven 42501 y la fila queda intacta.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT ON "report_runs" TO app_runtime;
REVOKE UPDATE, DELETE ON "report_runs" FROM app_runtime;
CREATE POLICY "report_runs_no_update" ON "report_runs" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "report_runs_no_delete" ON "report_runs" AS RESTRICTIVE FOR DELETE USING (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. `manual_review_flags` SEMI-append-only: nunca se borra; el UPDATE sólo
--    puede escribir las tres columnas de limpieza (GRANT de columna, ADR-0010),
--    y un trigger lo repite para que la restricción no dependa sólo del GRANT.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE UPDATE, DELETE ON "manual_review_flags" FROM app_runtime;
GRANT SELECT, INSERT ON "manual_review_flags" TO app_runtime;
GRANT UPDATE ("cleared_at","cleared_by_id","clear_reason") ON "manual_review_flags" TO app_runtime;
CREATE POLICY "manual_review_flags_no_delete" ON "manual_review_flags" AS RESTRICTIVE FOR DELETE USING (false);

CREATE OR REPLACE FUNCTION app.manual_review_flags_only_clear()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."period_start"    IS DISTINCT FROM OLD."period_start"
     OR NEW."period_end"      IS DISTINCT FROM OLD."period_end"
     OR NEW."scope"           IS DISTINCT FROM OLD."scope"
     OR NEW."reason"          IS DISTINCT FROM OLD."reason"
     OR NEW."created_by_id"   IS DISTINCT FROM OLD."created_by_id"
     OR NEW."created_at"      IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'manual_review_flags: sólo se pueden modificar cleared_at, cleared_by_id y clear_reason (E6, ADR-0010)'
      USING ERRCODE = '23514';
  END IF;
  -- Y una vez limpiado, se queda limpiado: no se "reabre" un flag, se crea otro.
  IF OLD."cleared_at" IS NOT NULL THEN
    RAISE EXCEPTION 'manual_review_flags: el flag % ya está limpiado; crea uno nuevo', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "manual_review_flags_only_clear_update"
  BEFORE UPDATE ON "manual_review_flags"
  FOR EACH ROW EXECUTE FUNCTION app.manual_review_flags_only_clear();

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. `analytics_key` la compone LA BASE (§2.3 punto 6)
--
--    `NULL <> NULL` en PostgreSQL: un `@@unique` con `analytics_hash`,
--    `margin_config_hash` y `allocation_run_id` nullables NO impide duplicados
--    (lección O-A6 de E4). La clave se materializa en una columna NOT NULL con
--    centinela `∅`, y se calcula en el trigger para que dos caminos —el modelo y
--    un INSERT manual— no puedan divergir.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.report_runs_analytics_key()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW."analytics_key" :=
       COALESCE(NEW."analytics_hash", '∅') || '|'
    || COALESCE(NEW."margin_config_hash", '∅') || '|'
    || COALESCE(NEW."allocation_run_id"::text, '∅');
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "report_runs_analytics_key"
  BEFORE INSERT ON "report_runs"
  FOR EACH ROW EXECUTE FUNCTION app.report_runs_analytics_key();

COMMENT ON TABLE "report_runs" IS
  'Informes emitidos y sellados (E6, ADR-0003). APPEND-ONLY: ni UPDATE ni DELETE. La clave de reutilización incluye params_hash, ledger_hash, analytics_key y git_sha.';
COMMENT ON TABLE "manual_review_flags" IS
  'Revisión manual forzada por un ADMIN sobre un periodo (E6, ADR-0012 D3). Semi-append-only: sólo se pueden escribir cleared_at, cleared_by_id y clear_reason.';
