#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera seeds/npgc.csv con el cuadro de cuentas del Plan General de Contabilidad
español (RD 1514/2007, versión general, texto consolidado con RD 1159/2010,
RD 602/2016 y RD 1/2021). Incluye todas las cuentas de PYMES (RD 1515/2007),
que son un subconjunto del cuadro general.

Uso:  python3 build_npgc.py [ruta_salida.csv]

Columnas del CSV:
  codigo, nombre, nivel, padre, grupo, naturaleza, estado_financiero, epigrafe,
  tipo_analitico, bidireccional, is_contra, pymes, epigrafe_pymes

  bidireccional  1 = cuenta corriente de saldo indistinto (551, 552, 554, 555).
                 `estado_financiero`/`epigrafe` son el lado DEUDOR; con saldo
                 acreedor el balance debe reclasificarla al pasivo.
  is_contra      1 = la naturaleza contradice el estado: la cuenta MINORA su masa
                 (28x, 29x, 39x, 49x, 59x, 406, 437, 606/608/609, 706/708/709,
                 103/104/108/109/153/154/190/192...). El renderizador debe restar.
  pymes          1 = la cuenta existe en el cuadro del PGC PYMES (RD 1515/2007
                 consolidado con RD 602/2016 y RD 1/2021). Reglas P-01..P-13 en
                 docs/design/E2-validacion-contable.md §2.1.
  epigrafe_pymes epigrafe del modelo abreviado/PYMES (numeracion propia de balance
                 y PyG); vacio si pymes = 0.

Correcciones aplicadas respecto a la version anterior (ver docs/design/E2-validacion-contable.md):
  D-1  5530-5533: MAPEO estaba cruzado respecto a NATURALEZA_OVERRIDE.
  D-2  190/192/194 y 1034/1044: de "Deudas a corto plazo" a Patrimonio neto.
  D-3  tipo_analitico de 65x, 67x, 678, 693/793, 694/695/794, 795, 696-699,
       77x, 778, 796-799 coherente con el bloque de PyG de su epigrafe.
  555  naturaleza DEUDORA con estado BALANCE_PASIVO (contradiccion interna) ->
       lado deudor + marca bidireccional.
"""
import csv
import os
import sys
from collections import Counter, OrderedDict

# ---------------------------------------------------------------------------
# 1. CUADRO DE CUENTAS  (codigo, nombre)
# ---------------------------------------------------------------------------
CUENTAS = [
    # ===================== GRUPO 1: FINANCIACIÓN BÁSICA =====================
    ("1", "Financiación básica"),
    ("10", "Capital"),
    ("100", "Capital social"),
    ("101", "Fondo social"),
    ("102", "Capital"),
    ("103", "Socios por desembolsos no exigidos"),
    ("1030", "Socios por desembolsos no exigidos, capital social"),
    ("1034", "Socios por desembolsos no exigidos, capital pendiente de inscripción"),
    ("104", "Socios por aportaciones no dinerarias pendientes"),
    ("1040", "Socios por aportaciones no dinerarias pendientes, capital social"),
    ("1044", "Socios por aportaciones no dinerarias pendientes, capital pendiente de inscripción"),
    ("108", "Acciones o participaciones propias en situaciones especiales"),
    ("109", "Acciones o participaciones propias para reducción de capital"),
    ("11", "Reservas y otros instrumentos de patrimonio"),
    ("110", "Prima de emisión o asunción"),
    ("111", "Otros instrumentos de patrimonio neto"),
    ("1110", "Patrimonio neto por emisión de instrumentos financieros compuestos"),
    ("1111", "Resto de instrumentos de patrimonio neto"),
    ("112", "Reserva legal"),
    ("113", "Reservas voluntarias"),
    ("114", "Reservas especiales"),
    ("1140", "Reservas para acciones o participaciones de la sociedad dominante"),
    ("1141", "Reservas estatutarias"),
    ("1142", "Reserva por capital amortizado"),
    ("1143", "Reserva por fondo de comercio"),
    ("1144", "Reservas por acciones propias aceptadas en garantía"),
    ("115", "Reservas por pérdidas y ganancias actuariales y otros ajustes"),
    ("118", "Aportaciones de socios o propietarios"),
    ("119", "Diferencias por ajuste del capital a euros"),
    ("12", "Resultados pendientes de aplicación"),
    ("120", "Remanente"),
    ("121", "Resultados negativos de ejercicios anteriores"),
    ("129", "Resultado del ejercicio"),
    ("13", "Subvenciones, donaciones y ajustes por cambios de valor"),
    ("130", "Subvenciones oficiales de capital"),
    ("131", "Donaciones y legados de capital"),
    ("132", "Otras subvenciones, donaciones y legados"),
    ("133", "Ajustes por valoración en activos financieros a valor razonable con cambios en el patrimonio neto"),
    ("134", "Operaciones de cobertura"),
    ("1340", "Cobertura de flujos de efectivo"),
    ("1341", "Cobertura de una inversión neta en un negocio en el extranjero"),
    ("135", "Diferencias de conversión"),
    ("136", "Ajustes por valoración en activos no corrientes y grupos enajenables de elementos, mantenidos para la venta"),
    ("137", "Ingresos fiscales a distribuir en varios ejercicios"),
    ("1370", "Ingresos fiscales por diferencias permanentes a distribuir en varios ejercicios"),
    ("1371", "Ingresos fiscales por deducciones y bonificaciones a distribuir en varios ejercicios"),
    ("14", "Provisiones"),
    ("140", "Provisión por retribuciones a largo plazo al personal"),
    ("141", "Provisión para impuestos"),
    ("142", "Provisión para otras responsabilidades"),
    ("143", "Provisión por desmantelamiento, retiro o rehabilitación del inmovilizado"),
    ("145", "Provisión para actuaciones medioambientales"),
    ("146", "Provisión para reestructuraciones"),
    ("147", "Provisión por transacciones con pagos basados en instrumentos de patrimonio"),
    ("15", "Deudas a largo plazo con características especiales"),
    ("150", "Acciones o participaciones a largo plazo consideradas como pasivos financieros"),
    ("153", "Desembolsos no exigidos por acciones o participaciones consideradas como pasivos financieros"),
    ("1533", "Desembolsos no exigidos, empresas del grupo"),
    ("1534", "Desembolsos no exigidos, empresas asociadas"),
    ("1535", "Desembolsos no exigidos, otras partes vinculadas"),
    ("1536", "Otros desembolsos no exigidos"),
    ("154", "Aportaciones no dinerarias pendientes por acciones o participaciones consideradas como pasivos financieros"),
    ("1543", "Aportaciones no dinerarias pendientes, empresas del grupo"),
    ("1544", "Aportaciones no dinerarias pendientes, empresas asociadas"),
    ("1545", "Aportaciones no dinerarias pendientes, otras partes vinculadas"),
    ("1546", "Otras aportaciones no dinerarias pendientes"),
    ("16", "Deudas a largo plazo con partes vinculadas"),
    ("160", "Deudas a largo plazo con entidades de crédito vinculadas"),
    ("1603", "Deudas a largo plazo con entidades de crédito, empresas del grupo"),
    ("1604", "Deudas a largo plazo con entidades de crédito, empresas asociadas"),
    ("1605", "Deudas a largo plazo con otras entidades de crédito vinculadas"),
    ("161", "Proveedores de inmovilizado a largo plazo, partes vinculadas"),
    ("1613", "Proveedores de inmovilizado a largo plazo, empresas del grupo"),
    ("1614", "Proveedores de inmovilizado a largo plazo, empresas asociadas"),
    ("1615", "Proveedores de inmovilizado a largo plazo, otras partes vinculadas"),
    ("162", "Acreedores por arrendamiento financiero a largo plazo, partes vinculadas"),
    ("1623", "Acreedores por arrendamiento financiero a largo plazo, empresas del grupo"),
    ("1624", "Acreedores por arrendamiento financiero a largo plazo, empresas asociadas"),
    ("1625", "Acreedores por arrendamiento financiero a largo plazo, otras partes vinculadas"),
    ("163", "Otras deudas a largo plazo con partes vinculadas"),
    ("1633", "Otras deudas a largo plazo, empresas del grupo"),
    ("1634", "Otras deudas a largo plazo, empresas asociadas"),
    ("1635", "Otras deudas a largo plazo, con otras partes vinculadas"),
    ("17", "Deudas a largo plazo por préstamos recibidos, empréstitos y otros conceptos"),
    ("170", "Deudas a largo plazo con entidades de crédito"),
    ("171", "Deudas a largo plazo"),
    ("172", "Deudas a largo plazo transformables en subvenciones, donaciones y legados"),
    ("173", "Proveedores de inmovilizado a largo plazo"),
    ("174", "Acreedores por arrendamiento financiero a largo plazo"),
    ("175", "Efectos a pagar a largo plazo"),
    ("176", "Pasivos por derivados financieros a largo plazo"),
    ("1765", "Pasivos por derivados financieros a largo plazo, cartera de negociación"),
    ("1768", "Pasivos por derivados financieros a largo plazo, instrumentos de cobertura"),
    ("177", "Obligaciones y bonos"),
    ("178", "Obligaciones y bonos convertibles"),
    ("179", "Deudas representadas en otros valores negociables"),
    ("18", "Pasivos por fianzas, garantías y otros conceptos a largo plazo"),
    ("180", "Fianzas recibidas a largo plazo"),
    ("181", "Anticipos recibidos por ventas o prestaciones de servicios a largo plazo"),
    ("185", "Depósitos recibidos a largo plazo"),
    ("189", "Garantías financieras a largo plazo"),
    ("19", "Situaciones transitorias de financiación"),
    ("190", "Acciones o participaciones emitidas"),
    ("192", "Suscriptores de acciones"),
    ("194", "Capital emitido pendiente de inscripción"),
    ("195", "Acciones o participaciones emitidas consideradas como pasivos financieros"),
    ("197", "Suscriptores de acciones consideradas como pasivos financieros"),
    ("199", "Acciones o participaciones emitidas consideradas como pasivos financieros pendientes de inscripción"),

    # ===================== GRUPO 2: ACTIVO NO CORRIENTE =====================
    ("2", "Activo no corriente"),
    ("20", "Inmovilizaciones intangibles"),
    ("200", "Investigación"),
    ("201", "Desarrollo"),
    ("202", "Concesiones administrativas"),
    ("203", "Propiedad industrial"),
    ("204", "Fondo de comercio"),
    ("205", "Derechos de traspaso"),
    ("206", "Aplicaciones informáticas"),
    ("209", "Anticipos para inmovilizaciones intangibles"),
    ("21", "Inmovilizaciones materiales"),
    ("210", "Terrenos y bienes naturales"),
    ("211", "Construcciones"),
    ("212", "Instalaciones técnicas"),
    ("213", "Maquinaria"),
    ("214", "Utillaje"),
    ("215", "Otras instalaciones"),
    ("216", "Mobiliario"),
    ("217", "Equipos para procesos de información"),
    ("218", "Elementos de transporte"),
    ("219", "Otro inmovilizado material"),
    ("22", "Inversiones inmobiliarias"),
    ("220", "Inversiones en terrenos y bienes naturales"),
    ("221", "Inversiones en construcciones"),
    ("23", "Inmovilizaciones materiales en curso"),
    ("230", "Adaptación de terrenos y bienes naturales"),
    ("231", "Construcciones en curso"),
    ("232", "Instalaciones técnicas en montaje"),
    ("233", "Maquinaria en montaje"),
    ("237", "Equipos para procesos de información en montaje"),
    ("239", "Anticipos para inmovilizaciones materiales"),
    ("24", "Inversiones financieras a largo plazo en partes vinculadas"),
    ("240", "Participaciones a largo plazo en partes vinculadas"),
    ("2403", "Participaciones a largo plazo en empresas del grupo"),
    ("2404", "Participaciones a largo plazo en empresas asociadas"),
    ("2405", "Participaciones a largo plazo en otras partes vinculadas"),
    ("241", "Valores representativos de deuda a largo plazo de partes vinculadas"),
    ("2413", "Valores representativos de deuda a largo plazo de empresas del grupo"),
    ("2414", "Valores representativos de deuda a largo plazo de empresas asociadas"),
    ("2415", "Valores representativos de deuda a largo plazo de otras partes vinculadas"),
    ("242", "Créditos a largo plazo a partes vinculadas"),
    ("2423", "Créditos a largo plazo a empresas del grupo"),
    ("2424", "Créditos a largo plazo a empresas asociadas"),
    ("2425", "Créditos a largo plazo a otras partes vinculadas"),
    ("249", "Desembolsos pendientes sobre participaciones a largo plazo en partes vinculadas"),
    ("2493", "Desembolsos pendientes sobre participaciones a largo plazo en empresas del grupo"),
    ("2494", "Desembolsos pendientes sobre participaciones a largo plazo en empresas asociadas"),
    ("2495", "Desembolsos pendientes sobre participaciones a largo plazo en otras partes vinculadas"),
    ("25", "Otras inversiones financieras a largo plazo"),
    ("250", "Inversiones financieras a largo plazo en instrumentos de patrimonio"),
    ("251", "Valores representativos de deuda a largo plazo"),
    ("252", "Créditos a largo plazo"),
    ("253", "Créditos a largo plazo por enajenación de inmovilizado"),
    ("254", "Créditos a largo plazo al personal"),
    ("255", "Activos por derivados financieros a largo plazo"),
    ("2550", "Activos por derivados financieros a largo plazo, cartera de negociación"),
    ("2553", "Activos por derivados financieros a largo plazo, instrumentos de cobertura"),
    ("257", "Derechos de reembolso derivados de contratos de seguro relativos a retribuciones a largo plazo al personal"),
    ("258", "Imposiciones a largo plazo"),
    ("259", "Desembolsos pendientes sobre participaciones en el patrimonio neto a largo plazo"),
    ("26", "Fianzas y depósitos constituidos a largo plazo"),
    ("260", "Fianzas constituidas a largo plazo"),
    ("265", "Depósitos constituidos a largo plazo"),
    ("28", "Amortización acumulada del inmovilizado"),
    ("280", "Amortización acumulada del inmovilizado intangible"),
    ("2800", "Amortización acumulada de investigación"),
    ("2801", "Amortización acumulada de desarrollo"),
    ("2802", "Amortización acumulada de concesiones administrativas"),
    ("2803", "Amortización acumulada de propiedad industrial"),
    ("2804", "Amortización acumulada de fondo de comercio"),
    ("2805", "Amortización acumulada de derechos de traspaso"),
    ("2806", "Amortización acumulada de aplicaciones informáticas"),
    ("281", "Amortización acumulada del inmovilizado material"),
    ("2811", "Amortización acumulada de construcciones"),
    ("2812", "Amortización acumulada de instalaciones técnicas"),
    ("2813", "Amortización acumulada de maquinaria"),
    ("2814", "Amortización acumulada de utillaje"),
    ("2815", "Amortización acumulada de otras instalaciones"),
    ("2816", "Amortización acumulada de mobiliario"),
    ("2817", "Amortización acumulada de equipos para procesos de información"),
    ("2818", "Amortización acumulada de elementos de transporte"),
    ("2819", "Amortización acumulada de otro inmovilizado material"),
    ("282", "Amortización acumulada de las inversiones inmobiliarias"),
    ("29", "Deterioro de valor de activos no corrientes"),
    ("290", "Deterioro de valor del inmovilizado intangible"),
    ("2900", "Deterioro de valor de investigación"),
    ("2901", "Deterioro de valor de desarrollo"),
    ("2902", "Deterioro de valor de concesiones administrativas"),
    ("2903", "Deterioro de valor de propiedad industrial"),
    ("2905", "Deterioro de valor de derechos de traspaso"),
    ("2906", "Deterioro de valor de aplicaciones informáticas"),
    ("291", "Deterioro de valor del inmovilizado material"),
    ("2910", "Deterioro de valor de terrenos y bienes naturales"),
    ("2911", "Deterioro de valor de construcciones"),
    ("2912", "Deterioro de valor de instalaciones técnicas"),
    ("2913", "Deterioro de valor de maquinaria"),
    ("2914", "Deterioro de valor de utillaje"),
    ("2915", "Deterioro de valor de otras instalaciones"),
    ("2916", "Deterioro de valor de mobiliario"),
    ("2917", "Deterioro de valor de equipos para procesos de información"),
    ("2918", "Deterioro de valor de elementos de transporte"),
    ("2919", "Deterioro de valor de otro inmovilizado material"),
    ("292", "Deterioro de valor de las inversiones inmobiliarias"),
    ("2920", "Deterioro de valor de los terrenos y bienes naturales"),
    ("2921", "Deterioro de valor de construcciones"),
    ("293", "Deterioro de valor de participaciones a largo plazo en partes vinculadas"),
    ("2933", "Deterioro de valor de participaciones a largo plazo en empresas del grupo"),
    ("2934", "Deterioro de valor de participaciones a largo plazo en empresas asociadas"),
    ("2935", "Deterioro de valor de participaciones a largo plazo en otras partes vinculadas"),
    ("294", "Deterioro de valor de valores representativos de deuda a largo plazo de partes vinculadas"),
    ("2943", "Deterioro de valor de valores representativos de deuda a largo plazo de empresas del grupo"),
    ("2944", "Deterioro de valor de valores representativos de deuda a largo plazo de empresas asociadas"),
    ("2945", "Deterioro de valor de valores representativos de deuda a largo plazo de otras partes vinculadas"),
    ("295", "Deterioro de valor de créditos a largo plazo a partes vinculadas"),
    ("2953", "Deterioro de valor de créditos a largo plazo a empresas del grupo"),
    ("2954", "Deterioro de valor de créditos a largo plazo a empresas asociadas"),
    ("2955", "Deterioro de valor de créditos a largo plazo a otras partes vinculadas"),
    ("296", "Deterioro de valor de participaciones en el patrimonio neto a largo plazo"),
    ("297", "Deterioro de valor de valores representativos de deuda a largo plazo"),
    ("298", "Deterioro de valor de créditos a largo plazo"),

    # ===================== GRUPO 3: EXISTENCIAS =====================
    ("3", "Existencias"),
    ("30", "Comerciales"),
    ("300", "Mercaderías A"),
    ("301", "Mercaderías B"),
    ("31", "Materias primas"),
    ("310", "Materias primas A"),
    ("311", "Materias primas B"),
    ("32", "Otros aprovisionamientos"),
    ("320", "Elementos y conjuntos incorporables"),
    ("321", "Combustibles"),
    ("322", "Repuestos"),
    ("325", "Materiales diversos"),
    ("326", "Embalajes"),
    ("327", "Envases"),
    ("328", "Material de oficina"),
    ("33", "Productos en curso"),
    ("330", "Productos en curso A"),
    ("331", "Productos en curso B"),
    ("34", "Productos semiterminados"),
    ("340", "Productos semiterminados A"),
    ("341", "Productos semiterminados B"),
    ("35", "Productos terminados"),
    ("350", "Productos terminados A"),
    ("351", "Productos terminados B"),
    ("36", "Subproductos, residuos y materiales recuperados"),
    ("360", "Subproductos A"),
    ("361", "Subproductos B"),
    ("365", "Residuos A"),
    ("366", "Residuos B"),
    ("368", "Materiales recuperados A"),
    ("369", "Materiales recuperados B"),
    ("39", "Deterioro de valor de las existencias"),
    ("390", "Deterioro de valor de las mercaderías"),
    ("391", "Deterioro de valor de las materias primas"),
    ("392", "Deterioro de valor de otros aprovisionamientos"),
    ("393", "Deterioro de valor de los productos en curso"),
    ("394", "Deterioro de valor de los productos semiterminados"),
    ("395", "Deterioro de valor de los productos terminados"),
    ("396", "Deterioro de valor de los subproductos, residuos y materiales recuperados"),

    # ===================== GRUPO 4: ACREEDORES Y DEUDORES =====================
    ("4", "Acreedores y deudores por operaciones comerciales"),
    ("40", "Proveedores"),
    ("400", "Proveedores"),
    ("4000", "Proveedores (euros)"),
    ("4004", "Proveedores (moneda extranjera)"),
    ("4009", "Proveedores, facturas pendientes de recibir o de formalizar"),
    ("401", "Proveedores, efectos comerciales a pagar"),
    ("403", "Proveedores, empresas del grupo"),
    ("4030", "Proveedores, empresas del grupo (euros)"),
    ("4031", "Efectos comerciales a pagar, empresas del grupo"),
    ("4034", "Proveedores, empresas del grupo (moneda extranjera)"),
    ("4036", "Envases y embalajes a devolver a proveedores, empresas del grupo"),
    ("4039", "Proveedores, empresas del grupo, facturas pendientes de recibir o de formalizar"),
    ("404", "Proveedores, empresas asociadas"),
    ("405", "Proveedores, otras partes vinculadas"),
    ("406", "Envases y embalajes a devolver a proveedores"),
    ("407", "Anticipos a proveedores"),
    ("41", "Acreedores varios"),
    ("410", "Acreedores por prestaciones de servicios"),
    ("4100", "Acreedores por prestaciones de servicios (euros)"),
    ("4104", "Acreedores por prestaciones de servicios (moneda extranjera)"),
    ("4109", "Acreedores por prestaciones de servicios, facturas pendientes de recibir o de formalizar"),
    ("411", "Acreedores, efectos comerciales a pagar"),
    ("419", "Acreedores por operaciones en común"),
    ("43", "Clientes"),
    ("430", "Clientes"),
    ("4300", "Clientes (euros)"),
    ("4304", "Clientes (moneda extranjera)"),
    ("4309", "Clientes, facturas pendientes de formalizar"),
    ("431", "Clientes, efectos comerciales a cobrar"),
    ("4310", "Efectos comerciales en cartera"),
    ("4311", "Efectos comerciales descontados"),
    ("4312", "Efectos comerciales en gestión de cobro"),
    ("4315", "Efectos comerciales impagados"),
    ("432", "Clientes, operaciones de «factoring»"),
    ("433", "Clientes, empresas del grupo"),
    ("4330", "Clientes, empresas del grupo (euros)"),
    ("4331", "Efectos comerciales a cobrar, empresas del grupo"),
    ("4332", "Clientes, empresas del grupo, operaciones de «factoring»"),
    ("4334", "Clientes, empresas del grupo (moneda extranjera)"),
    ("4336", "Clientes, empresas del grupo de dudoso cobro"),
    ("4337", "Envases y embalajes a devolver a clientes, empresas del grupo"),
    ("4339", "Clientes, empresas del grupo, facturas pendientes de formalizar"),
    ("434", "Clientes, empresas asociadas"),
    ("435", "Clientes, otras partes vinculadas"),
    ("436", "Clientes de dudoso cobro"),
    ("437", "Envases y embalajes a devolver por clientes"),
    ("438", "Anticipos de clientes"),
    ("44", "Deudores varios"),
    ("440", "Deudores"),
    ("4400", "Deudores (euros)"),
    ("4404", "Deudores (moneda extranjera)"),
    ("4409", "Deudores, facturas pendientes de formalizar"),
    ("441", "Deudores, efectos comerciales a cobrar"),
    ("4410", "Deudores, efectos comerciales en cartera"),
    ("4411", "Deudores, efectos comerciales descontados"),
    ("4412", "Deudores, efectos comerciales en gestión de cobro"),
    ("4415", "Deudores, efectos comerciales impagados"),
    ("446", "Deudores de dudoso cobro"),
    ("449", "Deudores por operaciones en común"),
    ("46", "Personal"),
    ("460", "Anticipos de remuneraciones"),
    ("465", "Remuneraciones pendientes de pago"),
    ("466", "Remuneraciones mediante sistemas de aportación definida pendientes de pago"),
    ("47", "Administraciones públicas"),
    ("470", "Hacienda Pública, deudora por diversos conceptos"),
    ("4700", "Hacienda Pública, deudora por IVA"),
    ("4708", "Hacienda Pública, deudora por subvenciones concedidas"),
    ("4709", "Hacienda Pública, deudora por devolución de impuestos"),
    ("471", "Organismos de la Seguridad Social, deudores"),
    ("472", "Hacienda Pública, IVA soportado"),
    ("473", "Hacienda Pública, retenciones y pagos a cuenta"),
    ("474", "Activos por impuesto diferido"),
    ("4740", "Activos por diferencias temporarias deducibles"),
    ("4742", "Derechos por deducciones y bonificaciones pendientes de aplicar"),
    ("4745", "Crédito por pérdidas a compensar del ejercicio"),
    ("475", "Hacienda Pública, acreedora por conceptos fiscales"),
    ("4750", "Hacienda Pública, acreedora por IVA"),
    ("4751", "Hacienda Pública, acreedora por retenciones practicadas"),
    ("4752", "Hacienda Pública, acreedora por impuesto sobre sociedades"),
    ("4758", "Hacienda Pública, acreedora por subvenciones a reintegrar"),
    ("476", "Organismos de la Seguridad Social, acreedores"),
    ("477", "Hacienda Pública, IVA repercutido"),
    ("479", "Pasivos por diferencias temporarias imponibles"),
    ("48", "Ajustes por periodificación"),
    ("480", "Gastos anticipados"),
    ("485", "Ingresos anticipados"),
    ("49", "Deterioro de valor de créditos comerciales y provisiones a corto plazo"),
    ("490", "Deterioro de valor de créditos por operaciones comerciales"),
    ("493", "Deterioro de valor de créditos por operaciones comerciales con partes vinculadas"),
    ("4933", "Deterioro de valor de créditos por operaciones comerciales con empresas del grupo"),
    ("4934", "Deterioro de valor de créditos por operaciones comerciales con empresas asociadas"),
    ("4935", "Deterioro de valor de créditos por operaciones comerciales con otras partes vinculadas"),
    ("499", "Provisiones por operaciones comerciales"),
    ("4994", "Provisión por contratos onerosos"),
    ("4999", "Provisión para otras operaciones comerciales"),

    # ===================== GRUPO 5: CUENTAS FINANCIERAS =====================
    ("5", "Cuentas financieras"),
    ("50", "Empréstitos, deudas con características especiales y otras emisiones análogas a corto plazo"),
    ("500", "Obligaciones y bonos a corto plazo"),
    ("501", "Obligaciones y bonos convertibles a corto plazo"),
    ("502", "Acciones o participaciones a corto plazo consideradas como pasivos financieros"),
    ("505", "Deudas representadas en otros valores negociables a corto plazo"),
    ("506", "Intereses a corto plazo de empréstitos y otras emisiones análogas"),
    ("507", "Dividendos de acciones o participaciones consideradas como pasivos financieros"),
    ("509", "Valores negociables amortizados"),
    ("5090", "Obligaciones y bonos amortizados"),
    ("5091", "Obligaciones y bonos convertibles amortizados"),
    ("5095", "Otros valores negociables amortizados"),
    ("51", "Deudas a corto plazo con partes vinculadas"),
    ("510", "Deudas a corto plazo con entidades de crédito vinculadas"),
    ("5103", "Deudas a corto plazo con entidades de crédito, empresas del grupo"),
    ("5104", "Deudas a corto plazo con entidades de crédito, empresas asociadas"),
    ("5105", "Deudas a corto plazo con otras entidades de crédito vinculadas"),
    ("511", "Proveedores de inmovilizado a corto plazo, partes vinculadas"),
    ("5113", "Proveedores de inmovilizado a corto plazo, empresas del grupo"),
    ("5114", "Proveedores de inmovilizado a corto plazo, empresas asociadas"),
    ("5115", "Proveedores de inmovilizado a corto plazo, otras partes vinculadas"),
    ("512", "Acreedores por arrendamiento financiero a corto plazo, partes vinculadas"),
    ("5123", "Acreedores por arrendamiento financiero a corto plazo, empresas del grupo"),
    ("5124", "Acreedores por arrendamiento financiero a corto plazo, empresas asociadas"),
    ("5125", "Acreedores por arrendamiento financiero a corto plazo, otras partes vinculadas"),
    ("513", "Otras deudas a corto plazo con partes vinculadas"),
    ("5133", "Otras deudas a corto plazo con empresas del grupo"),
    ("5134", "Otras deudas a corto plazo con empresas asociadas"),
    ("5135", "Otras deudas a corto plazo con otras partes vinculadas"),
    ("514", "Intereses a corto plazo de deudas con partes vinculadas"),
    ("5143", "Intereses a corto plazo de deudas, empresas del grupo"),
    ("5144", "Intereses a corto plazo de deudas, empresas asociadas"),
    ("5145", "Intereses a corto plazo de deudas, otras partes vinculadas"),
    ("52", "Deudas a corto plazo por préstamos recibidos y otros conceptos"),
    ("520", "Deudas a corto plazo con entidades de crédito"),
    ("5200", "Préstamos a corto plazo de entidades de crédito"),
    ("5201", "Deudas a corto plazo por crédito dispuesto"),
    ("5208", "Deudas por efectos descontados"),
    ("5209", "Deudas por operaciones de «factoring»"),
    ("521", "Deudas a corto plazo"),
    ("522", "Deudas a corto plazo transformables en subvenciones, donaciones y legados"),
    ("523", "Proveedores de inmovilizado a corto plazo"),
    ("524", "Acreedores por arrendamiento financiero a corto plazo"),
    ("525", "Efectos a pagar a corto plazo"),
    ("526", "Dividendo activo a pagar"),
    ("527", "Intereses a corto plazo de deudas con entidades de crédito"),
    ("528", "Intereses a corto plazo de deudas"),
    ("529", "Provisiones a corto plazo"),
    ("5290", "Provisión a corto plazo por retribuciones al personal"),
    ("5291", "Provisión a corto plazo para impuestos"),
    ("5292", "Provisión a corto plazo para otras responsabilidades"),
    ("5293", "Provisión a corto plazo por desmantelamiento, retiro o rehabilitación del inmovilizado"),
    ("5295", "Provisión a corto plazo para actuaciones medioambientales"),
    ("5296", "Provisión a corto plazo para reestructuraciones"),
    ("5297", "Provisión a corto plazo por transacciones con pagos basados en instrumentos de patrimonio"),
    ("53", "Inversiones financieras a corto plazo en partes vinculadas"),
    ("530", "Participaciones a corto plazo en partes vinculadas"),
    ("5303", "Participaciones a corto plazo en empresas del grupo"),
    ("5304", "Participaciones a corto plazo en empresas asociadas"),
    ("5305", "Participaciones a corto plazo en otras partes vinculadas"),
    ("531", "Valores representativos de deuda a corto plazo de partes vinculadas"),
    ("5313", "Valores representativos de deuda a corto plazo de empresas del grupo"),
    ("5314", "Valores representativos de deuda a corto plazo de empresas asociadas"),
    ("5315", "Valores representativos de deuda a corto plazo de otras partes vinculadas"),
    ("532", "Créditos a corto plazo a partes vinculadas"),
    ("5323", "Créditos a corto plazo a empresas del grupo"),
    ("5324", "Créditos a corto plazo a empresas asociadas"),
    ("5325", "Créditos a corto plazo a otras partes vinculadas"),
    ("533", "Intereses a corto plazo de valores representativos de deuda de partes vinculadas"),
    ("5333", "Intereses a corto plazo de valores representativos de deuda de empresas del grupo"),
    ("5334", "Intereses a corto plazo de valores representativos de deuda de empresas asociadas"),
    ("5335", "Intereses a corto plazo de valores representativos de deuda de otras partes vinculadas"),
    ("534", "Intereses a corto plazo de créditos a partes vinculadas"),
    ("5343", "Intereses a corto plazo de créditos a empresas del grupo"),
    ("5344", "Intereses a corto plazo de créditos a empresas asociadas"),
    ("5345", "Intereses a corto plazo de créditos a otras partes vinculadas"),
    ("535", "Dividendo a cobrar de inversiones financieras en partes vinculadas"),
    ("5353", "Dividendo a cobrar de empresas del grupo"),
    ("5354", "Dividendo a cobrar de empresas asociadas"),
    ("5355", "Dividendo a cobrar de otras partes vinculadas"),
    ("539", "Desembolsos pendientes sobre participaciones a corto plazo en partes vinculadas"),
    ("5393", "Desembolsos pendientes sobre participaciones a corto plazo en empresas del grupo"),
    ("5394", "Desembolsos pendientes sobre participaciones a corto plazo en empresas asociadas"),
    ("5395", "Desembolsos pendientes sobre participaciones a corto plazo en otras partes vinculadas"),
    ("54", "Otras inversiones financieras a corto plazo"),
    ("540", "Inversiones financieras a corto plazo en instrumentos de patrimonio"),
    ("541", "Valores representativos de deuda a corto plazo"),
    ("542", "Créditos a corto plazo"),
    ("543", "Créditos a corto plazo por enajenación de inmovilizado"),
    ("544", "Créditos a corto plazo al personal"),
    ("545", "Dividendo a cobrar"),
    ("546", "Intereses a corto plazo de valores representativos de deuda"),
    ("547", "Intereses a corto plazo de créditos"),
    ("548", "Imposiciones a corto plazo"),
    ("549", "Desembolsos pendientes sobre participaciones en el patrimonio neto a corto plazo"),
    ("55", "Otras cuentas no bancarias"),
    ("550", "Titular de la explotación"),
    ("551", "Cuenta corriente con socios y administradores"),
    ("552", "Cuenta corriente con otras personas y entidades vinculadas"),
    ("5523", "Cuenta corriente con empresas del grupo"),
    ("5524", "Cuenta corriente con empresas asociadas"),
    ("5525", "Cuenta corriente con otras partes vinculadas"),
    ("553", "Cuentas corrientes en fusiones y escisiones"),
    ("5530", "Socios de sociedad disuelta"),
    ("5531", "Socios, cuenta de fusión"),
    ("5532", "Socios de sociedad escindida"),
    ("5533", "Socios, cuenta de escisión"),
    ("554", "Cuenta corriente con uniones temporales de empresas y comunidades de bienes"),
    ("555", "Partidas pendientes de aplicación"),
    ("556", "Desembolsos exigidos sobre participaciones en el patrimonio neto"),
    ("5563", "Desembolsos exigidos sobre participaciones, empresas del grupo"),
    ("5564", "Desembolsos exigidos sobre participaciones, empresas asociadas"),
    ("5565", "Desembolsos exigidos sobre participaciones, otras partes vinculadas"),
    ("5566", "Desembolsos exigidos sobre participaciones de otras empresas"),
    ("557", "Dividendo activo a cuenta"),
    ("558", "Socios por desembolsos exigidos"),
    ("5580", "Socios por desembolsos exigidos sobre acciones o participaciones ordinarias"),
    ("5585", "Socios por desembolsos exigidos sobre acciones o participaciones consideradas como pasivos financieros"),
    ("559", "Derivados financieros a corto plazo"),
    ("5590", "Activos por derivados financieros a corto plazo, cartera de negociación"),
    ("5593", "Activos por derivados financieros a corto plazo, instrumentos de cobertura"),
    ("5595", "Pasivos por derivados financieros a corto plazo, cartera de negociación"),
    ("5598", "Pasivos por derivados financieros a corto plazo, instrumentos de cobertura"),
    ("56", "Fianzas y depósitos recibidos y constituidos a corto plazo y ajustes por periodificación"),
    ("560", "Fianzas recibidas a corto plazo"),
    ("561", "Depósitos recibidos a corto plazo"),
    ("565", "Fianzas constituidas a corto plazo"),
    ("566", "Depósitos constituidos a corto plazo"),
    ("567", "Intereses pagados por anticipado"),
    ("568", "Intereses cobrados por anticipado"),
    ("569", "Garantías financieras a corto plazo"),
    ("57", "Tesorería"),
    ("570", "Caja, euros"),
    ("571", "Caja, moneda extranjera"),
    ("572", "Bancos e instituciones de crédito c/c vista, euros"),
    ("573", "Bancos e instituciones de crédito c/c vista, moneda extranjera"),
    ("574", "Bancos e instituciones de crédito, cuentas de ahorro, euros"),
    ("575", "Bancos e instituciones de crédito, cuentas de ahorro, moneda extranjera"),
    ("576", "Inversiones a corto plazo de gran liquidez"),
    ("58", "Activos no corrientes mantenidos para la venta y activos y pasivos asociados"),
    ("580", "Inmovilizado"),
    ("581", "Inversiones con personas y entidades vinculadas"),
    ("582", "Inversiones financieras"),
    ("583", "Existencias, deudores comerciales y otras cuentas a cobrar"),
    ("584", "Otros activos"),
    ("585", "Provisiones"),
    ("586", "Deudas con características especiales"),
    ("587", "Deudas con personas y entidades vinculadas"),
    ("588", "Acreedores comerciales y otras cuentas a pagar"),
    ("589", "Otros pasivos"),
    ("59", "Deterioro del valor de inversiones financieras a corto plazo y de activos no corrientes mantenidos para la venta"),
    ("593", "Deterioro de valor de participaciones a corto plazo en partes vinculadas"),
    ("5933", "Deterioro de valor de participaciones a corto plazo en empresas del grupo"),
    ("5934", "Deterioro de valor de participaciones a corto plazo en empresas asociadas"),
    ("5935", "Deterioro de valor de participaciones a corto plazo en otras partes vinculadas"),
    ("594", "Deterioro de valor de valores representativos de deuda a corto plazo de partes vinculadas"),
    ("5943", "Deterioro de valor de valores representativos de deuda a corto plazo de empresas del grupo"),
    ("5944", "Deterioro de valor de valores representativos de deuda a corto plazo de empresas asociadas"),
    ("5945", "Deterioro de valor de valores representativos de deuda a corto plazo de otras partes vinculadas"),
    ("595", "Deterioro de valor de créditos a corto plazo a partes vinculadas"),
    ("5953", "Deterioro de valor de créditos a corto plazo a empresas del grupo"),
    ("5954", "Deterioro de valor de créditos a corto plazo a empresas asociadas"),
    ("5955", "Deterioro de valor de créditos a corto plazo a otras partes vinculadas"),
    ("596", "Deterioro de valor de participaciones a corto plazo"),
    ("597", "Deterioro de valor de valores representativos de deuda a corto plazo"),
    ("598", "Deterioro de valor de créditos a corto plazo"),
    ("599", "Deterioro de valor de activos no corrientes mantenidos para la venta"),
    ("5990", "Deterioro de valor de inmovilizado no corriente mantenido para la venta"),
    ("5991", "Deterioro de valor de inversiones con personas y entidades vinculadas no corrientes mantenidas para la venta"),
    ("5992", "Deterioro de valor de inversiones financieras no corrientes mantenidas para la venta"),
    ("5993", "Deterioro de valor de existencias, deudores comerciales y otras cuentas a cobrar integrados en un grupo enajenable mantenido para la venta"),
    ("5994", "Deterioro de valor de otros activos mantenidos para la venta"),

    # ===================== GRUPO 6: COMPRAS Y GASTOS =====================
    ("6", "Compras y gastos"),
    ("60", "Compras"),
    ("600", "Compras de mercaderías"),
    ("601", "Compras de materias primas"),
    ("602", "Compras de otros aprovisionamientos"),
    ("606", "Descuentos sobre compras por pronto pago"),
    ("6060", "Descuentos sobre compras por pronto pago de mercaderías"),
    ("6061", "Descuentos sobre compras por pronto pago de materias primas"),
    ("6062", "Descuentos sobre compras por pronto pago de otros aprovisionamientos"),
    ("607", "Trabajos realizados por otras empresas"),
    ("608", "Devoluciones de compras y operaciones similares"),
    ("6080", "Devoluciones de compras de mercaderías"),
    ("6081", "Devoluciones de compras de materias primas"),
    ("6082", "Devoluciones de compras de otros aprovisionamientos"),
    ("609", "«Rappels» por compras"),
    ("6090", "«Rappels» por compras de mercaderías"),
    ("6091", "«Rappels» por compras de materias primas"),
    ("6092", "«Rappels» por compras de otros aprovisionamientos"),
    ("61", "Variación de existencias"),
    ("610", "Variación de existencias de mercaderías"),
    ("611", "Variación de existencias de materias primas"),
    ("612", "Variación de existencias de otros aprovisionamientos"),
    ("62", "Servicios exteriores"),
    ("620", "Gastos en investigación y desarrollo del ejercicio"),
    ("621", "Arrendamientos y cánones"),
    ("622", "Reparaciones y conservación"),
    ("623", "Servicios de profesionales independientes"),
    ("624", "Transportes"),
    ("625", "Primas de seguros"),
    ("626", "Servicios bancarios y similares"),
    ("627", "Publicidad, propaganda y relaciones públicas"),
    ("628", "Suministros"),
    ("629", "Otros servicios"),
    ("63", "Tributos"),
    ("630", "Impuesto sobre beneficios"),
    ("6300", "Impuesto corriente"),
    ("6301", "Impuesto diferido"),
    ("631", "Otros tributos"),
    ("633", "Ajustes negativos en la imposición sobre beneficios"),
    ("634", "Ajustes negativos en la imposición indirecta"),
    ("6341", "Ajustes negativos en IVA de activo corriente"),
    ("6342", "Ajustes negativos en IVA de inversiones"),
    ("636", "Devolución de impuestos"),
    ("638", "Ajustes positivos en la imposición sobre beneficios"),
    ("639", "Ajustes positivos en la imposición indirecta"),
    ("6391", "Ajustes positivos en IVA de activo corriente"),
    ("6392", "Ajustes positivos en IVA de inversiones"),
    ("64", "Gastos de personal"),
    ("640", "Sueldos y salarios"),
    ("641", "Indemnizaciones"),
    ("642", "Seguridad Social a cargo de la empresa"),
    ("643", "Retribuciones a largo plazo mediante sistemas de aportación definida"),
    ("644", "Retribuciones a largo plazo mediante sistemas de prestación definida"),
    ("6440", "Contribuciones anuales"),
    ("6442", "Otros costes"),
    ("645", "Retribuciones al personal mediante instrumentos de patrimonio"),
    ("6450", "Retribuciones al personal liquidados con instrumentos de patrimonio"),
    ("6457", "Retribuciones al personal liquidados en efectivo basado en instrumentos de patrimonio"),
    ("649", "Otros gastos sociales"),
    ("65", "Otros gastos de gestión"),
    ("650", "Pérdidas de créditos comerciales incobrables"),
    ("651", "Resultados de operaciones en común"),
    ("6510", "Beneficio transferido (gestor)"),
    ("6511", "Pérdida soportada (partícipe o asociado no gestor)"),
    ("659", "Otras pérdidas en gestión corriente"),
    ("66", "Gastos financieros"),
    ("660", "Gastos financieros por actualización de provisiones"),
    ("661", "Intereses de obligaciones y bonos"),
    ("6610", "Intereses de obligaciones y bonos a largo plazo, empresas del grupo"),
    ("6611", "Intereses de obligaciones y bonos a largo plazo, empresas asociadas"),
    ("6612", "Intereses de obligaciones y bonos a largo plazo, otras partes vinculadas"),
    ("6613", "Intereses de obligaciones y bonos a largo plazo, otras empresas"),
    ("6615", "Intereses de obligaciones y bonos a corto plazo, empresas del grupo"),
    ("6616", "Intereses de obligaciones y bonos a corto plazo, empresas asociadas"),
    ("6617", "Intereses de obligaciones y bonos a corto plazo, otras partes vinculadas"),
    ("6618", "Intereses de obligaciones y bonos a corto plazo, otras empresas"),
    ("662", "Intereses de deudas"),
    ("6620", "Intereses de deudas, empresas del grupo"),
    ("6621", "Intereses de deudas, empresas asociadas"),
    ("6622", "Intereses de deudas, otras partes vinculadas"),
    ("6623", "Intereses de deudas con entidades de crédito"),
    ("6624", "Intereses de deudas, otras empresas"),
    ("663", "Pérdidas por valoración de instrumentos financieros por su valor razonable"),
    ("6630", "Pérdidas de cartera de negociación"),
    ("6631", "Pérdidas de designados por la empresa"),
    ("6632", "Pérdidas de activos financieros a valor razonable con cambios en el patrimonio neto"),
    ("6633", "Pérdidas de instrumentos de cobertura"),
    ("664", "Gastos por dividendos de acciones o participaciones consideradas como pasivos financieros"),
    ("6640", "Dividendos de pasivos, empresas del grupo"),
    ("6641", "Dividendos de pasivos, empresas asociadas"),
    ("6642", "Dividendos de pasivos, otras partes vinculadas"),
    ("6643", "Dividendos de pasivos, otras empresas"),
    ("665", "Intereses por descuento de efectos y operaciones de «factoring»"),
    ("6650", "Intereses por descuento de efectos en entidades de crédito del grupo"),
    ("6651", "Intereses por descuento de efectos en entidades de crédito asociadas"),
    ("6652", "Intereses por descuento de efectos en otras entidades de crédito vinculadas"),
    ("6653", "Intereses por descuento de efectos en otras entidades de crédito"),
    ("6654", "Intereses por operaciones de «factoring» con entidades de crédito del grupo"),
    ("6655", "Intereses por operaciones de «factoring» con entidades de crédito asociadas"),
    ("6656", "Intereses por operaciones de «factoring» con otras entidades de crédito vinculadas"),
    ("6657", "Intereses por operaciones de «factoring» con otras entidades de crédito"),
    ("666", "Pérdidas en participaciones y valores representativos de deuda"),
    ("6660", "Pérdidas en valores representativos de deuda a largo plazo, empresas del grupo"),
    ("6661", "Pérdidas en valores representativos de deuda a largo plazo, empresas asociadas"),
    ("6662", "Pérdidas en valores representativos de deuda a largo plazo, otras partes vinculadas"),
    ("6663", "Pérdidas en participaciones y valores representativos de deuda a largo plazo, otras empresas"),
    ("6665", "Pérdidas en participaciones y valores representativos de deuda a corto plazo, empresas del grupo"),
    ("6666", "Pérdidas en participaciones y valores representativos de deuda a corto plazo, empresas asociadas"),
    ("6667", "Pérdidas en valores representativos de deuda a corto plazo, otras partes vinculadas"),
    ("6668", "Pérdidas en valores representativos de deuda a corto plazo, otras empresas"),
    ("667", "Pérdidas de créditos no comerciales"),
    ("6670", "Pérdidas de créditos a largo plazo, empresas del grupo"),
    ("6671", "Pérdidas de créditos a largo plazo, empresas asociadas"),
    ("6672", "Pérdidas de créditos a largo plazo, otras partes vinculadas"),
    ("6673", "Pérdidas de créditos a largo plazo, otras empresas"),
    ("6675", "Pérdidas de créditos a corto plazo, empresas del grupo"),
    ("6676", "Pérdidas de créditos a corto plazo, empresas asociadas"),
    ("6677", "Pérdidas de créditos a corto plazo, otras partes vinculadas"),
    ("6678", "Pérdidas de créditos a corto plazo, otras empresas"),
    ("668", "Diferencias negativas de cambio"),
    ("669", "Otros gastos financieros"),
    ("67", "Pérdidas procedentes de activos no corrientes y gastos excepcionales"),
    ("670", "Pérdidas procedentes del inmovilizado intangible"),
    ("671", "Pérdidas procedentes del inmovilizado material"),
    ("672", "Pérdidas procedentes de las inversiones inmobiliarias"),
    ("673", "Pérdidas procedentes de participaciones a largo plazo en partes vinculadas"),
    ("6733", "Pérdidas procedentes de participaciones a largo plazo, empresas del grupo"),
    ("6734", "Pérdidas procedentes de participaciones a largo plazo, empresas asociadas"),
    ("6735", "Pérdidas procedentes de participaciones a largo plazo, otras partes vinculadas"),
    ("675", "Pérdidas por operaciones con obligaciones propias"),
    ("678", "Gastos excepcionales"),
    ("68", "Dotaciones para amortizaciones"),
    ("680", "Amortización del inmovilizado intangible"),
    ("681", "Amortización del inmovilizado material"),
    ("682", "Amortización de las inversiones inmobiliarias"),
    ("69", "Pérdidas por deterioro y otras dotaciones"),
    ("690", "Pérdidas por deterioro del inmovilizado intangible"),
    ("691", "Pérdidas por deterioro del inmovilizado material"),
    ("692", "Pérdidas por deterioro de las inversiones inmobiliarias"),
    ("693", "Pérdidas por deterioro de existencias"),
    ("6930", "Pérdidas por deterioro de productos terminados y en curso de fabricación"),
    ("6931", "Pérdidas por deterioro de mercaderías"),
    ("6932", "Pérdidas por deterioro de materias primas"),
    ("6933", "Pérdidas por deterioro de otros aprovisionamientos"),
    ("694", "Pérdidas por deterioro de créditos por operaciones comerciales"),
    ("695", "Dotación a la provisión por operaciones comerciales"),
    ("6954", "Dotación a la provisión por contratos onerosos"),
    ("6959", "Dotación a la provisión para otras operaciones comerciales"),
    ("696", "Pérdidas por deterioro de participaciones y valores representativos de deuda a largo plazo"),
    ("6960", "Pérdidas por deterioro de participaciones en instrumentos de patrimonio neto a largo plazo, empresas del grupo"),
    ("6961", "Pérdidas por deterioro de participaciones en instrumentos de patrimonio neto a largo plazo, empresas asociadas"),
    ("6962", "Pérdidas por deterioro de participaciones en instrumentos de patrimonio neto a largo plazo, otras partes vinculadas"),
    ("6963", "Pérdidas por deterioro de participaciones en instrumentos de patrimonio neto a largo plazo, otras empresas"),
    ("6965", "Pérdidas por deterioro en valores representativos de deuda a largo plazo, empresas del grupo"),
    ("6966", "Pérdidas por deterioro en valores representativos de deuda a largo plazo, empresas asociadas"),
    ("6967", "Pérdidas por deterioro en valores representativos de deuda a largo plazo, otras partes vinculadas"),
    ("6968", "Pérdidas por deterioro en valores representativos de deuda a largo plazo, otras empresas"),
    ("697", "Pérdidas por deterioro de créditos a largo plazo"),
    ("6970", "Pérdidas por deterioro de créditos a largo plazo, empresas del grupo"),
    ("6971", "Pérdidas por deterioro de créditos a largo plazo, empresas asociadas"),
    ("6972", "Pérdidas por deterioro de créditos a largo plazo, otras partes vinculadas"),
    ("6973", "Pérdidas por deterioro de créditos a largo plazo, otras empresas"),
    ("698", "Pérdidas por deterioro de participaciones y valores representativos de deuda a corto plazo"),
    ("6980", "Pérdidas por deterioro de participaciones en instrumentos de patrimonio neto a corto plazo, empresas del grupo"),
    ("6981", "Pérdidas por deterioro de participaciones en instrumentos de patrimonio neto a corto plazo, empresas asociadas"),
    ("6985", "Pérdidas por deterioro en valores representativos de deuda a corto plazo, empresas del grupo"),
    ("6986", "Pérdidas por deterioro en valores representativos de deuda a corto plazo, empresas asociadas"),
    ("6987", "Pérdidas por deterioro en valores representativos de deuda a corto plazo, otras partes vinculadas"),
    ("6988", "Pérdidas por deterioro en valores representativos de deuda a corto plazo, otras empresas"),
    ("699", "Pérdidas por deterioro de créditos a corto plazo"),
    ("6990", "Pérdidas por deterioro de créditos a corto plazo, empresas del grupo"),
    ("6991", "Pérdidas por deterioro de créditos a corto plazo, empresas asociadas"),
    ("6992", "Pérdidas por deterioro de créditos a corto plazo, otras partes vinculadas"),
    ("6993", "Pérdidas por deterioro de créditos a corto plazo, otras empresas"),

    # ===================== GRUPO 7: VENTAS E INGRESOS =====================
    ("7", "Ventas e ingresos"),
    ("70", "Ventas de mercaderías, de producción propia, de servicios, etc."),
    ("700", "Ventas de mercaderías"),
    ("701", "Ventas de productos terminados"),
    ("702", "Ventas de productos semiterminados"),
    ("703", "Ventas de subproductos y residuos"),
    ("704", "Ventas de envases y embalajes"),
    ("705", "Prestaciones de servicios"),
    ("706", "Descuentos sobre ventas por pronto pago"),
    ("7060", "Descuentos sobre ventas por pronto pago de mercaderías"),
    ("7061", "Descuentos sobre ventas por pronto pago de productos terminados"),
    ("7062", "Descuentos sobre ventas por pronto pago de productos semiterminados"),
    ("7063", "Descuentos sobre ventas por pronto pago de subproductos y residuos"),
    ("7064", "Descuentos sobre ventas por pronto pago de envases y embalajes"),
    ("708", "Devoluciones de ventas y operaciones similares"),
    ("7080", "Devoluciones de ventas de mercaderías"),
    ("7081", "Devoluciones de ventas de productos terminados"),
    ("7082", "Devoluciones de ventas de productos semiterminados"),
    ("7083", "Devoluciones de ventas de subproductos y residuos"),
    ("7084", "Devoluciones de ventas de envases y embalajes"),
    ("709", "«Rappels» sobre ventas"),
    ("7090", "«Rappels» sobre ventas de mercaderías"),
    ("7091", "«Rappels» sobre ventas de productos terminados"),
    ("7092", "«Rappels» sobre ventas de productos semiterminados"),
    ("7093", "«Rappels» sobre ventas de subproductos y residuos"),
    ("7094", "«Rappels» sobre ventas de envases y embalajes"),
    ("71", "Variación de existencias"),
    ("710", "Variación de existencias de productos en curso"),
    ("711", "Variación de existencias de productos semiterminados"),
    ("712", "Variación de existencias de productos terminados"),
    ("713", "Variación de existencias de subproductos, residuos y materiales recuperados"),
    ("73", "Trabajos realizados para la empresa"),
    ("730", "Trabajos realizados para el inmovilizado intangible"),
    ("731", "Trabajos realizados para el inmovilizado material"),
    ("732", "Trabajos realizados en inmovilizado material en curso"),
    ("733", "Trabajos realizados para las inversiones inmobiliarias"),
    ("74", "Subvenciones, donaciones y legados"),
    ("740", "Subvenciones, donaciones y legados a la explotación"),
    ("746", "Subvenciones, donaciones y legados de capital transferidos al resultado del ejercicio"),
    ("747", "Otras subvenciones, donaciones y legados transferidos al resultado del ejercicio"),
    ("75", "Otros ingresos de gestión"),
    ("751", "Resultados de operaciones en común"),
    ("7510", "Pérdida transferida (gestor)"),
    ("7511", "Beneficio atribuido (partícipe o asociado no gestor)"),
    ("752", "Ingresos por arrendamientos"),
    ("753", "Ingresos de propiedad industrial cedida en explotación"),
    ("754", "Ingresos por comisiones"),
    ("755", "Ingresos por servicios al personal"),
    ("759", "Ingresos por servicios diversos"),
    ("76", "Ingresos financieros"),
    ("760", "Ingresos de participaciones en instrumentos de patrimonio"),
    ("7600", "Ingresos de participaciones en instrumentos de patrimonio, empresas del grupo"),
    ("7601", "Ingresos de participaciones en instrumentos de patrimonio, empresas asociadas"),
    ("7602", "Ingresos de participaciones en instrumentos de patrimonio, otras partes vinculadas"),
    ("7603", "Ingresos de participaciones en instrumentos de patrimonio, otras empresas"),
    ("761", "Ingresos de valores representativos de deuda"),
    ("7610", "Ingresos de valores representativos de deuda, empresas del grupo"),
    ("7611", "Ingresos de valores representativos de deuda, empresas asociadas"),
    ("7612", "Ingresos de valores representativos de deuda, otras partes vinculadas"),
    ("7613", "Ingresos de valores representativos de deuda, otras empresas"),
    ("762", "Ingresos de créditos"),
    ("7620", "Ingresos de créditos a largo plazo"),
    ("7621", "Ingresos de créditos a corto plazo"),
    ("763", "Beneficios por valoración de instrumentos financieros por su valor razonable"),
    ("7630", "Beneficios de cartera de negociación"),
    ("7631", "Beneficios de designados por la empresa"),
    ("7632", "Beneficios de activos financieros a valor razonable con cambios en el patrimonio neto"),
    ("7633", "Beneficios de instrumentos de cobertura"),
    ("766", "Beneficios en participaciones y valores representativos de deuda"),
    ("7660", "Beneficios en valores representativos de deuda a largo plazo, empresas del grupo"),
    ("7661", "Beneficios en valores representativos de deuda a largo plazo, empresas asociadas"),
    ("7662", "Beneficios en valores representativos de deuda a largo plazo, otras partes vinculadas"),
    ("7663", "Beneficios en participaciones y valores representativos de deuda a largo plazo, otras empresas"),
    ("7665", "Beneficios en participaciones y valores representativos de deuda a corto plazo, empresas del grupo"),
    ("7666", "Beneficios en participaciones y valores representativos de deuda a corto plazo, empresas asociadas"),
    ("7667", "Beneficios en valores representativos de deuda a corto plazo, otras partes vinculadas"),
    ("7668", "Beneficios en valores representativos de deuda a corto plazo, otras empresas"),
    ("767", "Ingresos de activos afectos y de derechos de reembolso relativos a retribuciones a largo plazo"),
    ("768", "Diferencias positivas de cambio"),
    ("769", "Otros ingresos financieros"),
    ("77", "Beneficios procedentes de activos no corrientes e ingresos excepcionales"),
    ("770", "Beneficios procedentes del inmovilizado intangible"),
    ("771", "Beneficios procedentes del inmovilizado material"),
    ("772", "Beneficios procedentes de las inversiones inmobiliarias"),
    ("773", "Beneficios procedentes de participaciones a largo plazo en partes vinculadas"),
    ("7733", "Beneficios procedentes de participaciones a largo plazo, empresas del grupo"),
    ("7734", "Beneficios procedentes de participaciones a largo plazo, empresas asociadas"),
    ("7735", "Beneficios procedentes de participaciones a largo plazo, otras partes vinculadas"),
    ("774", "Diferencia negativa en combinaciones de negocios"),
    ("775", "Beneficios por operaciones con obligaciones propias"),
    ("778", "Ingresos excepcionales"),
    ("79", "Excesos y aplicaciones de provisiones y de pérdidas por deterioro"),
    ("790", "Reversión del deterioro del inmovilizado intangible"),
    ("791", "Reversión del deterioro del inmovilizado material"),
    ("792", "Reversión del deterioro de las inversiones inmobiliarias"),
    ("793", "Reversión del deterioro de existencias"),
    ("7930", "Reversión del deterioro de productos terminados y en curso de fabricación"),
    ("7931", "Reversión del deterioro de mercaderías"),
    ("7932", "Reversión del deterioro de materias primas"),
    ("7933", "Reversión del deterioro de otros aprovisionamientos"),
    ("794", "Reversión del deterioro de créditos por operaciones comerciales"),
    ("795", "Exceso de provisiones"),
    ("7950", "Exceso de provisión por retribuciones al personal"),
    ("7951", "Exceso de provisión para impuestos"),
    ("7952", "Exceso de provisión para otras responsabilidades"),
    ("7954", "Exceso de provisión por operaciones comerciales"),
    ("7955", "Exceso de provisión para actuaciones medioambientales"),
    ("7956", "Exceso de provisión para reestructuraciones"),
    ("7957", "Exceso de provisión por transacciones con pagos basados en instrumentos de patrimonio"),
    ("796", "Reversión del deterioro de participaciones y valores representativos de deuda a largo plazo"),
    ("7960", "Reversión del deterioro de participaciones en instrumentos de patrimonio neto a largo plazo, empresas del grupo"),
    ("7961", "Reversión del deterioro de participaciones en instrumentos de patrimonio neto a largo plazo, empresas asociadas"),
    ("7962", "Reversión del deterioro de participaciones en instrumentos de patrimonio neto a largo plazo, otras partes vinculadas"),
    ("7963", "Reversión del deterioro de participaciones en instrumentos de patrimonio neto a largo plazo, otras empresas"),
    ("7965", "Reversión del deterioro de valores representativos de deuda a largo plazo, empresas del grupo"),
    ("7966", "Reversión del deterioro de valores representativos de deuda a largo plazo, empresas asociadas"),
    ("7967", "Reversión del deterioro de valores representativos de deuda a largo plazo, otras partes vinculadas"),
    ("7968", "Reversión del deterioro de valores representativos de deuda a largo plazo, otras empresas"),
    ("797", "Reversión del deterioro de créditos a largo plazo"),
    ("7970", "Reversión del deterioro de créditos a largo plazo, empresas del grupo"),
    ("7971", "Reversión del deterioro de créditos a largo plazo, empresas asociadas"),
    ("7972", "Reversión del deterioro de créditos a largo plazo, otras partes vinculadas"),
    ("7973", "Reversión del deterioro de créditos a largo plazo, otras empresas"),
    ("798", "Reversión del deterioro de participaciones y valores representativos de deuda a corto plazo"),
    ("7980", "Reversión del deterioro de participaciones en instrumentos de patrimonio neto a corto plazo, empresas del grupo"),
    ("7981", "Reversión del deterioro de participaciones en instrumentos de patrimonio neto a corto plazo, empresas asociadas"),
    ("7985", "Reversión del deterioro en valores representativos de deuda a corto plazo, empresas del grupo"),
    ("7986", "Reversión del deterioro en valores representativos de deuda a corto plazo, empresas asociadas"),
    ("7987", "Reversión del deterioro en valores representativos de deuda a corto plazo, otras partes vinculadas"),
    ("7988", "Reversión del deterioro en valores representativos de deuda a corto plazo, otras empresas"),
    ("799", "Reversión del deterioro de créditos a corto plazo"),
    ("7990", "Reversión del deterioro de créditos a corto plazo, empresas del grupo"),
    ("7991", "Reversión del deterioro de créditos a corto plazo, empresas asociadas"),
    ("7992", "Reversión del deterioro de créditos a corto plazo, otras partes vinculadas"),
    ("7993", "Reversión del deterioro de créditos a corto plazo, otras empresas"),

    # ============ GRUPO 8: GASTOS IMPUTADOS AL PATRIMONIO NETO ============
    ("8", "Gastos imputados al patrimonio neto"),
    ("80", "Gastos financieros por valoración de activos y pasivos"),
    ("800", "Pérdidas en activos financieros a valor razonable con cambios en el patrimonio neto"),
    ("802", "Transferencia de beneficios en activos financieros a valor razonable con cambios en el patrimonio neto"),
    ("81", "Gastos en operaciones de cobertura"),
    ("810", "Pérdidas por coberturas de flujos de efectivo"),
    ("811", "Pérdidas por coberturas de inversiones netas en un negocio en el extranjero"),
    ("812", "Transferencia de beneficios por coberturas de flujos de efectivo"),
    ("813", "Transferencia de beneficios por coberturas de inversiones netas en un negocio en el extranjero"),
    ("82", "Gastos por diferencias de conversión"),
    ("820", "Diferencias de conversión negativas"),
    ("821", "Transferencia de diferencias de conversión positivas"),
    ("83", "Impuesto sobre beneficios"),
    ("830", "Impuesto sobre beneficios"),
    ("8300", "Impuesto corriente"),
    ("8301", "Impuesto diferido"),
    ("833", "Ajustes negativos en la imposición sobre beneficios"),
    ("834", "Ingresos fiscales por diferencias permanentes"),
    ("835", "Ingresos fiscales por deducciones y bonificaciones"),
    ("836", "Transferencia de diferencias permanentes"),
    ("837", "Transferencia de deducciones y bonificaciones"),
    ("838", "Ajustes positivos en la imposición sobre beneficios"),
    ("84", "Transferencias de subvenciones, donaciones y legados"),
    ("840", "Transferencia de subvenciones oficiales de capital"),
    ("841", "Transferencia de donaciones y legados de capital"),
    ("842", "Transferencia de otras subvenciones, donaciones y legados"),
    ("85", "Gastos por pérdidas actuariales y ajustes en los activos por retribuciones a largo plazo de prestación definida"),
    ("850", "Pérdidas actuariales"),
    ("851", "Ajustes negativos en activos por retribuciones a largo plazo de prestación definida"),
    ("86", "Gastos por activos no corrientes en venta"),
    ("860", "Pérdidas en activos no corrientes y grupos enajenables de elementos mantenidos para la venta"),
    ("862", "Transferencia de beneficios en activos no corrientes y grupos enajenables de elementos mantenidos para la venta"),
    ("89", "Gastos de participaciones en empresas del grupo o asociadas con ajustes valorativos positivos previos"),
    ("891", "Deterioro de participaciones en el capital de empresas del grupo"),
    ("892", "Deterioro de participaciones en el capital de empresas asociadas"),

    # ============ GRUPO 9: INGRESOS IMPUTADOS AL PATRIMONIO NETO ============
    ("9", "Ingresos imputados al patrimonio neto"),
    ("90", "Ingresos financieros por valoración de activos y pasivos"),
    ("900", "Beneficios en activos financieros a valor razonable con cambios en el patrimonio neto"),
    ("902", "Transferencia de pérdidas de activos financieros a valor razonable con cambios en el patrimonio neto"),
    ("91", "Ingresos en operaciones de cobertura"),
    ("910", "Beneficios por coberturas de flujos de efectivo"),
    ("911", "Beneficios por coberturas de una inversión neta en un negocio en el extranjero"),
    ("912", "Transferencia de pérdidas por coberturas de flujos de efectivo"),
    ("913", "Transferencia de pérdidas por coberturas de una inversión neta en un negocio en el extranjero"),
    ("92", "Ingresos por diferencias de conversión"),
    ("920", "Diferencias de conversión positivas"),
    ("921", "Transferencia de diferencias de conversión negativas"),
    ("94", "Ingresos por subvenciones, donaciones y legados"),
    ("940", "Ingresos de subvenciones oficiales de capital"),
    ("941", "Ingresos de donaciones y legados de capital"),
    ("942", "Ingresos de otras subvenciones, donaciones y legados"),
    ("95", "Ingresos por ganancias actuariales y ajustes en los activos por retribuciones a largo plazo de prestación definida"),
    ("950", "Ganancias actuariales"),
    ("951", "Ajustes positivos en activos por retribuciones a largo plazo de prestación definida"),
    ("96", "Ingresos por activos no corrientes en venta"),
    ("960", "Beneficios en activos no corrientes y grupos enajenables de elementos mantenidos para la venta"),
    ("962", "Transferencia de pérdidas en activos no corrientes y grupos enajenables de elementos mantenidos para la venta"),
    ("99", "Ingresos de participaciones en empresas del grupo o asociadas con ajustes valorativos positivos previos"),
    ("991", "Recuperación de ajustes valorativos negativos previos, empresas del grupo"),
    ("992", "Recuperación de ajustes valorativos negativos previos, empresas asociadas"),
    ("993", "Transferencia por deterioro de ajustes valorativos negativos previos, empresas del grupo"),
    ("994", "Transferencia por deterioro de ajustes valorativos negativos previos, empresas asociadas"),
]

# ---------------------------------------------------------------------------
# 2. MAPEO A ESTADOS FINANCIEROS (modelo NORMAL de cuentas anuales, PGC 2007
#    consolidado 2021).  Clave = prefijo de código; gana el prefijo más largo.
#    Valor = (estado_financiero, epigrafe).  Estado "" = contenedor mixto.
# ---------------------------------------------------------------------------
ACT, PAS, PN, PYG, ECPN = "BALANCE_ACTIVO", "BALANCE_PASIVO", "BALANCE_PN", "PYG", "ECPN"

ANC = "A) Activo no corriente"
AC = "B) Activo corriente"
FP = "A) Patrimonio neto / A-1) Fondos propios"
ACV = "A) Patrimonio neto / A-2) Ajustes por cambios de valor"
SUBV = "A) Patrimonio neto / A-3) Subvenciones, donaciones y legados recibidos"
PNC = "B) Pasivo no corriente"
PC = "C) Pasivo corriente"
ECPN_B = "B) Ingresos y gastos imputados directamente al patrimonio neto"
ECPN_C = "C) Transferencias a la cuenta de pérdidas y ganancias"

MAPEO = {
    # ---------------- GRUPO 1 ----------------
    "1": ("", ""),
    "10": (PN, f"{FP} / I. Capital"),
    "100": (PN, f"{FP} / I. Capital / 1. Capital escriturado"),
    "101": (PN, f"{FP} / I. Capital / 1. Capital escriturado"),
    "102": (PN, f"{FP} / I. Capital / 1. Capital escriturado"),
    "103": (PN, f"{FP} / I. Capital / 2. (Capital no exigido)"),
    "1034": (PN, f"{FP} / I. Capital / 2. (Capital no exigido)"),   # FIX D-2: minora capital, no es deuda
    "104": (PN, f"{FP} / I. Capital / 2. (Capital no exigido)"),
    "1044": (PN, f"{FP} / I. Capital / 2. (Capital no exigido)"),   # FIX D-2
    "108": (PN, f"{FP} / IV. (Acciones y participaciones en patrimonio propias)"),
    "109": (PN, f"{FP} / IV. (Acciones y participaciones en patrimonio propias)"),
    "11": (PN, FP),
    "110": (PN, f"{FP} / II. Prima de emisión"),
    "111": (PN, f"{FP} / IX. Otros instrumentos de patrimonio neto"),
    "112": (PN, f"{FP} / III. Reservas / 1. Legal y estatutarias"),
    "113": (PN, f"{FP} / III. Reservas / 2. Otras reservas"),
    "114": (PN, f"{FP} / III. Reservas / 2. Otras reservas"),
    "1141": (PN, f"{FP} / III. Reservas / 1. Legal y estatutarias"),
    "115": (PN, f"{FP} / III. Reservas / 2. Otras reservas"),
    "118": (PN, f"{FP} / VI. Otras aportaciones de socios"),
    "119": (PN, f"{FP} / III. Reservas / 2. Otras reservas"),
    "12": (PN, f"{FP} / V. Resultados de ejercicios anteriores"),
    "120": (PN, f"{FP} / V. Resultados de ejercicios anteriores / 1. Remanente"),
    "121": (PN, f"{FP} / V. Resultados de ejercicios anteriores / 2. (Resultados negativos de ejercicios anteriores)"),
    "129": (PN, f"{FP} / VII. Resultado del ejercicio"),
    "13": (PN, "A) Patrimonio neto"),
    "130": (PN, SUBV),
    "131": (PN, SUBV),
    "132": (PN, SUBV),
    "133": (PN, f"{ACV} / I. Activos financieros a valor razonable con cambios en el patrimonio neto"),
    "134": (PN, f"{ACV} / II. Operaciones de cobertura"),
    "1341": (PN, f"{ACV} / V. Otros"),
    "135": (PN, f"{ACV} / IV. Diferencia de conversión"),
    "136": (PN, f"{ACV} / III. Activos no corrientes y pasivos vinculados, mantenidos para la venta"),
    "137": (PN, SUBV),
    "14": (PAS, f"{PNC} / I. Provisiones a largo plazo"),
    "140": (PAS, f"{PNC} / I. Provisiones a largo plazo / 1. Obligaciones por prestaciones a largo plazo al personal"),
    "141": (PAS, f"{PNC} / I. Provisiones a largo plazo / 4. Otras provisiones"),
    "142": (PAS, f"{PNC} / I. Provisiones a largo plazo / 4. Otras provisiones"),
    "143": (PAS, f"{PNC} / I. Provisiones a largo plazo / 4. Otras provisiones"),
    "145": (PAS, f"{PNC} / I. Provisiones a largo plazo / 2. Actuaciones medioambientales"),
    "146": (PAS, f"{PNC} / I. Provisiones a largo plazo / 3. Provisiones por reestructuración"),
    "147": (PAS, f"{PNC} / I. Provisiones a largo plazo / 4. Otras provisiones"),
    "15": (PAS, f"{PNC} / VII. Deuda con características especiales a largo plazo"),
    "16": (PAS, f"{PNC} / III. Deudas con empresas del grupo y asociadas a largo plazo"),
    "1605": (PAS, f"{PNC} / II. Deudas a largo plazo / 2. Deudas con entidades de crédito"),
    "1615": (PAS, f"{PNC} / II. Deudas a largo plazo / 5. Otros pasivos financieros"),
    "1625": (PAS, f"{PNC} / II. Deudas a largo plazo / 3. Acreedores por arrendamiento financiero"),
    "1635": (PAS, f"{PNC} / II. Deudas a largo plazo / 5. Otros pasivos financieros"),
    "17": (PAS, f"{PNC} / II. Deudas a largo plazo"),
    "170": (PAS, f"{PNC} / II. Deudas a largo plazo / 2. Deudas con entidades de crédito"),
    "171": (PAS, f"{PNC} / II. Deudas a largo plazo / 5. Otros pasivos financieros"),
    "172": (PAS, f"{PNC} / II. Deudas a largo plazo / 5. Otros pasivos financieros"),
    "173": (PAS, f"{PNC} / II. Deudas a largo plazo / 5. Otros pasivos financieros"),
    "174": (PAS, f"{PNC} / II. Deudas a largo plazo / 3. Acreedores por arrendamiento financiero"),
    "175": (PAS, f"{PNC} / II. Deudas a largo plazo / 5. Otros pasivos financieros"),
    "176": (PAS, f"{PNC} / II. Deudas a largo plazo / 4. Derivados"),
    "177": (PAS, f"{PNC} / II. Deudas a largo plazo / 1. Obligaciones y otros valores negociables"),
    "178": (PAS, f"{PNC} / II. Deudas a largo plazo / 1. Obligaciones y otros valores negociables"),
    "179": (PAS, f"{PNC} / II. Deudas a largo plazo / 1. Obligaciones y otros valores negociables"),
    "18": (PAS, f"{PNC} / II. Deudas a largo plazo / 5. Otros pasivos financieros"),
    "181": (PAS, f"{PNC} / V. Periodificaciones a largo plazo"),
    "19": ("", ""),                                                  # FIX D-2: contenedor mixto (190/192/194 -> PN ; 195/197/199 -> PC)
    "190": (PN, f"{FP} / I. Capital / 1. Capital escriturado"),      # FIX D-2
    "192": (PN, f"{FP} / I. Capital / 2. (Capital no exigido)"),     # FIX D-2
    "194": (PN, f"{FP} / I. Capital / 1. Capital escriturado"),      # FIX D-2
    "195": (PAS, f"{PC} / VII. Deuda con características especiales a corto plazo"),
    "197": (PAS, f"{PC} / VII. Deuda con características especiales a corto plazo"),
    "199": (PAS, f"{PC} / VII. Deuda con características especiales a corto plazo"),

    # ---------------- GRUPO 2 ----------------
    "2": (ACT, ANC),
    "20": (ACT, f"{ANC} / I. Inmovilizado intangible"),
    "200": (ACT, f"{ANC} / I. Inmovilizado intangible / 6. Investigación"),
    "201": (ACT, f"{ANC} / I. Inmovilizado intangible / 1. Desarrollo"),
    "202": (ACT, f"{ANC} / I. Inmovilizado intangible / 2. Concesiones"),
    "203": (ACT, f"{ANC} / I. Inmovilizado intangible / 3. Patentes, licencias, marcas y similares"),
    "204": (ACT, f"{ANC} / I. Inmovilizado intangible / 4. Fondo de comercio"),
    "205": (ACT, f"{ANC} / I. Inmovilizado intangible / 7. Otro inmovilizado intangible"),
    "206": (ACT, f"{ANC} / I. Inmovilizado intangible / 5. Aplicaciones informáticas"),
    "209": (ACT, f"{ANC} / I. Inmovilizado intangible / 7. Otro inmovilizado intangible"),
    "21": (ACT, f"{ANC} / II. Inmovilizado material"),
    "210": (ACT, f"{ANC} / II. Inmovilizado material / 1. Terrenos y construcciones"),
    "211": (ACT, f"{ANC} / II. Inmovilizado material / 1. Terrenos y construcciones"),
    "212": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "213": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "214": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "215": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "216": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "217": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "218": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "219": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "22": (ACT, f"{ANC} / III. Inversiones inmobiliarias"),
    "220": (ACT, f"{ANC} / III. Inversiones inmobiliarias / 1. Terrenos"),
    "221": (ACT, f"{ANC} / III. Inversiones inmobiliarias / 2. Construcciones"),
    "23": (ACT, f"{ANC} / II. Inmovilizado material / 3. Inmovilizado en curso y anticipos"),
    "24": (ACT, f"{ANC} / IV. Inversiones en empresas del grupo y asociadas a largo plazo"),
    "240": (ACT, f"{ANC} / IV. Inversiones en empresas del grupo y asociadas a largo plazo / 1. Instrumentos de patrimonio"),
    "2405": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 1. Instrumentos de patrimonio"),
    "241": (ACT, f"{ANC} / IV. Inversiones en empresas del grupo y asociadas a largo plazo / 3. Valores representativos de deuda"),
    "2415": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 3. Valores representativos de deuda"),
    "242": (ACT, f"{ANC} / IV. Inversiones en empresas del grupo y asociadas a largo plazo / 2. Créditos a empresas"),
    "2425": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 2. Créditos a terceros"),
    "249": (ACT, f"{ANC} / IV. Inversiones en empresas del grupo y asociadas a largo plazo / 1. Instrumentos de patrimonio"),
    "2495": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 1. Instrumentos de patrimonio"),
    "25": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo"),
    "250": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 1. Instrumentos de patrimonio"),
    "251": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 3. Valores representativos de deuda"),
    "252": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 2. Créditos a terceros"),
    "253": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 2. Créditos a terceros"),
    "254": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 2. Créditos a terceros"),
    "255": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 4. Derivados"),
    "257": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 5. Otros activos financieros"),
    "258": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 5. Otros activos financieros"),
    "259": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 1. Instrumentos de patrimonio"),
    "26": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 5. Otros activos financieros"),
    "28": (ACT, ANC),
    "280": (ACT, f"{ANC} / I. Inmovilizado intangible"),
    "2800": (ACT, f"{ANC} / I. Inmovilizado intangible / 6. Investigación"),
    "2801": (ACT, f"{ANC} / I. Inmovilizado intangible / 1. Desarrollo"),
    "2802": (ACT, f"{ANC} / I. Inmovilizado intangible / 2. Concesiones"),
    "2803": (ACT, f"{ANC} / I. Inmovilizado intangible / 3. Patentes, licencias, marcas y similares"),
    "2804": (ACT, f"{ANC} / I. Inmovilizado intangible / 4. Fondo de comercio"),
    "2805": (ACT, f"{ANC} / I. Inmovilizado intangible / 7. Otro inmovilizado intangible"),
    "2806": (ACT, f"{ANC} / I. Inmovilizado intangible / 5. Aplicaciones informáticas"),
    "281": (ACT, f"{ANC} / II. Inmovilizado material"),
    "2811": (ACT, f"{ANC} / II. Inmovilizado material / 1. Terrenos y construcciones"),
    "2812": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2813": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2814": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2815": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2816": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2817": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2818": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2819": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "282": (ACT, f"{ANC} / III. Inversiones inmobiliarias / 2. Construcciones"),
    "29": (ACT, ANC),
    "290": (ACT, f"{ANC} / I. Inmovilizado intangible"),
    "2900": (ACT, f"{ANC} / I. Inmovilizado intangible / 6. Investigación"),
    "2901": (ACT, f"{ANC} / I. Inmovilizado intangible / 1. Desarrollo"),
    "2902": (ACT, f"{ANC} / I. Inmovilizado intangible / 2. Concesiones"),
    "2903": (ACT, f"{ANC} / I. Inmovilizado intangible / 3. Patentes, licencias, marcas y similares"),
    "2905": (ACT, f"{ANC} / I. Inmovilizado intangible / 7. Otro inmovilizado intangible"),
    "2906": (ACT, f"{ANC} / I. Inmovilizado intangible / 5. Aplicaciones informáticas"),
    "291": (ACT, f"{ANC} / II. Inmovilizado material"),
    "2910": (ACT, f"{ANC} / II. Inmovilizado material / 1. Terrenos y construcciones"),
    "2911": (ACT, f"{ANC} / II. Inmovilizado material / 1. Terrenos y construcciones"),
    "2912": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2913": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2914": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2915": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2916": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2917": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2918": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "2919": (ACT, f"{ANC} / II. Inmovilizado material / 2. Instalaciones técnicas y otro inmovilizado material"),
    "292": (ACT, f"{ANC} / III. Inversiones inmobiliarias"),
    "2920": (ACT, f"{ANC} / III. Inversiones inmobiliarias / 1. Terrenos"),
    "2921": (ACT, f"{ANC} / III. Inversiones inmobiliarias / 2. Construcciones"),
    "293": (ACT, f"{ANC} / IV. Inversiones en empresas del grupo y asociadas a largo plazo / 1. Instrumentos de patrimonio"),
    "2935": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 1. Instrumentos de patrimonio"),
    "294": (ACT, f"{ANC} / IV. Inversiones en empresas del grupo y asociadas a largo plazo / 3. Valores representativos de deuda"),
    "2945": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 3. Valores representativos de deuda"),
    "295": (ACT, f"{ANC} / IV. Inversiones en empresas del grupo y asociadas a largo plazo / 2. Créditos a empresas"),
    "2955": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 2. Créditos a terceros"),
    "296": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 1. Instrumentos de patrimonio"),
    "297": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 3. Valores representativos de deuda"),
    "298": (ACT, f"{ANC} / V. Inversiones financieras a largo plazo / 2. Créditos a terceros"),

    # ---------------- GRUPO 3 ----------------
    "3": (ACT, f"{AC} / II. Existencias"),
    "30": (ACT, f"{AC} / II. Existencias / 1. Comerciales"),
    "31": (ACT, f"{AC} / II. Existencias / 2. Materias primas y otros aprovisionamientos"),
    "32": (ACT, f"{AC} / II. Existencias / 2. Materias primas y otros aprovisionamientos"),
    "33": (ACT, f"{AC} / II. Existencias / 3. Productos en curso"),
    "34": (ACT, f"{AC} / II. Existencias / 3. Productos en curso"),
    "35": (ACT, f"{AC} / II. Existencias / 4. Productos terminados"),
    "36": (ACT, f"{AC} / II. Existencias / 5. Subproductos, residuos y materiales recuperados"),
    "39": (ACT, f"{AC} / II. Existencias"),
    "390": (ACT, f"{AC} / II. Existencias / 1. Comerciales"),
    "391": (ACT, f"{AC} / II. Existencias / 2. Materias primas y otros aprovisionamientos"),
    "392": (ACT, f"{AC} / II. Existencias / 2. Materias primas y otros aprovisionamientos"),
    "393": (ACT, f"{AC} / II. Existencias / 3. Productos en curso"),
    "394": (ACT, f"{AC} / II. Existencias / 3. Productos en curso"),
    "395": (ACT, f"{AC} / II. Existencias / 4. Productos terminados"),
    "396": (ACT, f"{AC} / II. Existencias / 5. Subproductos, residuos y materiales recuperados"),

    # ---------------- GRUPO 4 ----------------
    "4": ("", ""),
    "40": (PAS, f"{PC} / V. Acreedores comerciales y otras cuentas a pagar / 1. Proveedores"),
    "403": (PAS, f"{PC} / V. Acreedores comerciales y otras cuentas a pagar / 2. Proveedores, empresas del grupo y asociadas"),
    "404": (PAS, f"{PC} / V. Acreedores comerciales y otras cuentas a pagar / 2. Proveedores, empresas del grupo y asociadas"),
    "407": (ACT, f"{AC} / II. Existencias / 6. Anticipos a proveedores"),
    "41": (PAS, f"{PC} / V. Acreedores comerciales y otras cuentas a pagar / 3. Acreedores varios"),
    "43": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 1. Clientes por ventas y prestaciones de servicios"),
    "433": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 2. Clientes, empresas del grupo y asociadas"),
    "434": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 2. Clientes, empresas del grupo y asociadas"),
    "438": (PAS, f"{PC} / V. Acreedores comerciales y otras cuentas a pagar / 7. Anticipos de clientes"),
    "44": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 3. Deudores varios"),
    "46": ("", ""),
    "460": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 4. Personal"),
    "465": (PAS, f"{PC} / V. Acreedores comerciales y otras cuentas a pagar / 4. Personal (remuneraciones pendientes de pago)"),
    "466": (PAS, f"{PC} / V. Acreedores comerciales y otras cuentas a pagar / 4. Personal (remuneraciones pendientes de pago)"),
    "47": ("", ""),
    "470": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 6. Otros créditos con las Administraciones Públicas"),
    "4709": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 5. Activos por impuesto corriente"),
    "471": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 6. Otros créditos con las Administraciones Públicas"),
    "472": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 6. Otros créditos con las Administraciones Públicas"),
    "473": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 6. Otros créditos con las Administraciones Públicas"),
    "474": (ACT, f"{ANC} / VI. Activos por impuesto diferido"),
    "475": (PAS, f"{PC} / V. Acreedores comerciales y otras cuentas a pagar / 6. Otras deudas con las Administraciones Públicas"),
    "4752": (PAS, f"{PC} / V. Acreedores comerciales y otras cuentas a pagar / 5. Pasivos por impuesto corriente"),
    "476": (PAS, f"{PC} / V. Acreedores comerciales y otras cuentas a pagar / 6. Otras deudas con las Administraciones Públicas"),
    "477": (PAS, f"{PC} / V. Acreedores comerciales y otras cuentas a pagar / 6. Otras deudas con las Administraciones Públicas"),
    "479": (PAS, f"{PNC} / IV. Pasivos por impuesto diferido"),
    "48": ("", ""),
    "480": (ACT, f"{AC} / VI. Periodificaciones a corto plazo"),
    "485": (PAS, f"{PC} / VI. Periodificaciones a corto plazo"),
    "49": ("", ""),
    "490": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 1. Clientes por ventas y prestaciones de servicios"),
    "493": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 2. Clientes, empresas del grupo y asociadas"),
    "4935": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 1. Clientes por ventas y prestaciones de servicios"),
    "499": (PAS, f"{PC} / II. Provisiones a corto plazo"),

    # ---------------- GRUPO 5 ----------------
    "5": ("", ""),
    "50": (PAS, f"{PC} / III. Deudas a corto plazo / 1. Obligaciones y otros valores negociables"),
    "502": (PAS, f"{PC} / VII. Deuda con características especiales a corto plazo"),
    "507": (PAS, f"{PC} / VII. Deuda con características especiales a corto plazo"),
    "509": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "51": (PAS, f"{PC} / IV. Deudas con empresas del grupo y asociadas a corto plazo"),
    "5105": (PAS, f"{PC} / III. Deudas a corto plazo / 2. Deudas con entidades de crédito"),
    "5115": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "5125": (PAS, f"{PC} / III. Deudas a corto plazo / 3. Acreedores por arrendamiento financiero"),
    "5135": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "5145": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "52": (PAS, f"{PC} / III. Deudas a corto plazo"),
    "520": (PAS, f"{PC} / III. Deudas a corto plazo / 2. Deudas con entidades de crédito"),
    "521": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "522": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "523": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "524": (PAS, f"{PC} / III. Deudas a corto plazo / 3. Acreedores por arrendamiento financiero"),
    "525": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "526": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "527": (PAS, f"{PC} / III. Deudas a corto plazo / 2. Deudas con entidades de crédito"),
    "528": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "529": (PAS, f"{PC} / II. Provisiones a corto plazo"),
    "53": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo"),
    "530": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo / 1. Instrumentos de patrimonio"),
    "5305": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 1. Instrumentos de patrimonio"),
    "531": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo / 3. Valores representativos de deuda"),
    "5315": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 3. Valores representativos de deuda"),
    "532": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo / 2. Créditos a empresas"),
    "5325": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 2. Créditos a empresas"),
    "533": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo / 3. Valores representativos de deuda"),
    "5335": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 3. Valores representativos de deuda"),
    "534": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo / 2. Créditos a empresas"),
    "5345": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 2. Créditos a empresas"),
    "535": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo / 5. Otros activos financieros"),
    "5355": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 5. Otros activos financieros"),
    "539": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo / 1. Instrumentos de patrimonio"),
    "5395": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 1. Instrumentos de patrimonio"),
    "54": (ACT, f"{AC} / V. Inversiones financieras a corto plazo"),
    "540": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 1. Instrumentos de patrimonio"),
    "541": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 3. Valores representativos de deuda"),
    "542": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 2. Créditos a empresas"),
    "543": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 2. Créditos a empresas"),
    "544": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 4. Personal"),
    "545": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 5. Otros activos financieros"),
    "546": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 3. Valores representativos de deuda"),
    "547": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 2. Créditos a empresas"),
    "548": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 5. Otros activos financieros"),
    "549": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 1. Instrumentos de patrimonio"),
    "55": ("", ""),
    "550": (PN, f"{FP} / I. Capital / 1. Capital escriturado"),
    "551": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 5. Otros activos financieros"),
    "552": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo / 5. Otros activos financieros"),
    "5525": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 5. Otros activos financieros"),
    "553": ("", ""),
    # FIX D-1: MAPEO estaba cruzado respecto a NATURALEZA_OVERRIDE.
    # 5530/5532 (deudoras) = derecho de credito frente a socios -> Activo
    # 5531/5533 (acreedoras) = obligacion frente a socios       -> Pasivo
    "5530": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 3. Deudores varios"),
    "5531": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "5532": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 3. Deudores varios"),
    "5533": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "554": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 3. Deudores varios"),
    "555": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 3. Deudores varios"),  # FIX: bidireccional, lado deudor

    "556": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "5563": (PAS, f"{PC} / IV. Deudas con empresas del grupo y asociadas a corto plazo"),
    "5564": (PAS, f"{PC} / IV. Deudas con empresas del grupo y asociadas a corto plazo"),
    "557": (PN, f"{FP} / VIII. (Dividendo a cuenta)"),
    "558": (ACT, f"{AC} / III. Deudores comerciales y otras cuentas a cobrar / 7. Accionistas (socios) por desembolsos exigidos"),
    "559": ("", ""),
    "5590": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 4. Derivados"),
    "5593": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 4. Derivados"),
    "5595": (PAS, f"{PC} / III. Deudas a corto plazo / 4. Derivados"),
    "5598": (PAS, f"{PC} / III. Deudas a corto plazo / 4. Derivados"),
    "56": ("", ""),
    "560": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "561": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "565": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 5. Otros activos financieros"),
    "566": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 5. Otros activos financieros"),
    "567": (ACT, f"{AC} / VI. Periodificaciones a corto plazo"),
    "568": (PAS, f"{PC} / VI. Periodificaciones a corto plazo"),
    "569": (PAS, f"{PC} / III. Deudas a corto plazo / 5. Otros pasivos financieros"),
    "57": (ACT, f"{AC} / VII. Efectivo y otros activos líquidos equivalentes / 1. Tesorería"),
    "576": (ACT, f"{AC} / VII. Efectivo y otros activos líquidos equivalentes / 2. Otros activos líquidos equivalentes"),
    "58": ("", ""),
    "580": (ACT, f"{AC} / I. Activos no corrientes mantenidos para la venta"),
    "581": (ACT, f"{AC} / I. Activos no corrientes mantenidos para la venta"),
    "582": (ACT, f"{AC} / I. Activos no corrientes mantenidos para la venta"),
    "583": (ACT, f"{AC} / I. Activos no corrientes mantenidos para la venta"),
    "584": (ACT, f"{AC} / I. Activos no corrientes mantenidos para la venta"),
    "585": (PAS, f"{PC} / I. Pasivos vinculados con activos no corrientes mantenidos para la venta"),
    "586": (PAS, f"{PC} / I. Pasivos vinculados con activos no corrientes mantenidos para la venta"),
    "587": (PAS, f"{PC} / I. Pasivos vinculados con activos no corrientes mantenidos para la venta"),
    "588": (PAS, f"{PC} / I. Pasivos vinculados con activos no corrientes mantenidos para la venta"),
    "589": (PAS, f"{PC} / I. Pasivos vinculados con activos no corrientes mantenidos para la venta"),
    "59": (ACT, AC),
    "593": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo / 1. Instrumentos de patrimonio"),
    "5935": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 1. Instrumentos de patrimonio"),
    "594": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo / 3. Valores representativos de deuda"),
    "5945": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 3. Valores representativos de deuda"),
    "595": (ACT, f"{AC} / IV. Inversiones en empresas del grupo y asociadas a corto plazo / 2. Créditos a empresas"),
    "5955": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 2. Créditos a empresas"),
    "596": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 1. Instrumentos de patrimonio"),
    "597": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 3. Valores representativos de deuda"),
    "598": (ACT, f"{AC} / V. Inversiones financieras a corto plazo / 2. Créditos a empresas"),
    "599": (ACT, f"{AC} / I. Activos no corrientes mantenidos para la venta"),

    # ---------------- GRUPO 6 (PyG modelo normal) ----------------
    "6": (PYG, ""),
    "60": (PYG, "4. Aprovisionamientos"),
    "600": (PYG, "4. Aprovisionamientos / a) Consumo de mercaderías"),
    "601": (PYG, "4. Aprovisionamientos / b) Consumo de materias primas y otras materias consumibles"),
    "602": (PYG, "4. Aprovisionamientos / b) Consumo de materias primas y otras materias consumibles"),
    "6060": (PYG, "4. Aprovisionamientos / a) Consumo de mercaderías"),
    "6061": (PYG, "4. Aprovisionamientos / b) Consumo de materias primas y otras materias consumibles"),
    "6062": (PYG, "4. Aprovisionamientos / b) Consumo de materias primas y otras materias consumibles"),
    "607": (PYG, "4. Aprovisionamientos / c) Trabajos realizados por otras empresas"),
    "6080": (PYG, "4. Aprovisionamientos / a) Consumo de mercaderías"),
    "6081": (PYG, "4. Aprovisionamientos / b) Consumo de materias primas y otras materias consumibles"),
    "6082": (PYG, "4. Aprovisionamientos / b) Consumo de materias primas y otras materias consumibles"),
    "6090": (PYG, "4. Aprovisionamientos / a) Consumo de mercaderías"),
    "6091": (PYG, "4. Aprovisionamientos / b) Consumo de materias primas y otras materias consumibles"),
    "6092": (PYG, "4. Aprovisionamientos / b) Consumo de materias primas y otras materias consumibles"),
    "61": (PYG, "4. Aprovisionamientos"),
    "610": (PYG, "4. Aprovisionamientos / a) Consumo de mercaderías"),
    "611": (PYG, "4. Aprovisionamientos / b) Consumo de materias primas y otras materias consumibles"),
    "612": (PYG, "4. Aprovisionamientos / b) Consumo de materias primas y otras materias consumibles"),
    "62": (PYG, "7. Otros gastos de explotación / a) Servicios exteriores"),
    "63": (PYG, "7. Otros gastos de explotación / b) Tributos"),
    "630": (PYG, "20. Impuestos sobre beneficios"),
    "633": (PYG, "20. Impuestos sobre beneficios"),
    "638": (PYG, "20. Impuestos sobre beneficios"),
    "64": (PYG, "6. Gastos de personal"),
    "640": (PYG, "6. Gastos de personal / a) Sueldos, salarios y asimilados"),
    "641": (PYG, "6. Gastos de personal / a) Sueldos, salarios y asimilados"),
    "642": (PYG, "6. Gastos de personal / b) Cargas sociales"),
    "643": (PYG, "6. Gastos de personal / b) Cargas sociales"),
    "644": (PYG, "6. Gastos de personal / c) Provisiones"),
    "645": (PYG, "6. Gastos de personal"),
    "6450": (PYG, "6. Gastos de personal / a) Sueldos, salarios y asimilados"),
    "6457": (PYG, "6. Gastos de personal / c) Provisiones"),
    "649": (PYG, "6. Gastos de personal / b) Cargas sociales"),
    "65": (PYG, "7. Otros gastos de explotación"),
    "650": (PYG, "7. Otros gastos de explotación / c) Pérdidas, deterioro y variación de provisiones por operaciones comerciales"),
    "651": (PYG, "7. Otros gastos de explotación / d) Otros gastos de gestión corriente"),
    "659": (PYG, "7. Otros gastos de explotación / d) Otros gastos de gestión corriente"),
    "66": (PYG, "15. Gastos financieros"),
    "660": (PYG, "15. Gastos financieros / c) Por actualización de provisiones"),
    "6610": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6611": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6612": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "6613": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "6615": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6616": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6617": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "6618": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "6620": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6621": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6622": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "6623": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "6624": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "663": (PYG, "16. Variación de valor razonable en instrumentos financieros / a) Cartera de negociación y otros"),
    "6632": (PYG, "16. Variación de valor razonable en instrumentos financieros / b) Imputación al resultado del ejercicio por activos financieros a valor razonable con cambios en el patrimonio neto"),
    "6640": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6641": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6642": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "6643": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "6650": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6651": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6652": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "6653": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "6654": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6655": (PYG, "15. Gastos financieros / a) Por deudas con empresas del grupo y asociadas"),
    "6656": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "6657": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "666": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / b) Resultados por enajenaciones y otras"),
    "667": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / b) Resultados por enajenaciones y otras"),
    "668": (PYG, "17. Diferencias de cambio"),
    "669": (PYG, "15. Gastos financieros / b) Por deudas con terceros"),
    "67": (PYG, ""),
    "670": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / b) Resultados por enajenaciones y otras"),
    "671": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / b) Resultados por enajenaciones y otras"),
    "672": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / b) Resultados por enajenaciones y otras"),
    "673": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / b) Resultados por enajenaciones y otras"),
    "675": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / b) Resultados por enajenaciones y otras"),
    "678": (PYG, "13. Otros resultados"),
    "68": (PYG, "8. Amortización del inmovilizado"),
    "69": (PYG, ""),
    "690": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / a) Deterioros y pérdidas"),
    "691": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / a) Deterioros y pérdidas"),
    "692": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / a) Deterioros y pérdidas"),
    "693": (PYG, "4. Aprovisionamientos"),
    "6930": (PYG, "2. Variación de existencias de productos terminados y en curso de fabricación"),
    "6931": (PYG, "4. Aprovisionamientos / d) Deterioro de mercaderías, materias primas y otros aprovisionamientos"),
    "6932": (PYG, "4. Aprovisionamientos / d) Deterioro de mercaderías, materias primas y otros aprovisionamientos"),
    "6933": (PYG, "4. Aprovisionamientos / d) Deterioro de mercaderías, materias primas y otros aprovisionamientos"),
    "694": (PYG, "7. Otros gastos de explotación / c) Pérdidas, deterioro y variación de provisiones por operaciones comerciales"),
    "695": (PYG, "7. Otros gastos de explotación / c) Pérdidas, deterioro y variación de provisiones por operaciones comerciales"),
    "696": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / a) Deterioros y pérdidas"),
    "697": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / a) Deterioros y pérdidas"),
    "698": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / a) Deterioros y pérdidas"),
    "699": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / a) Deterioros y pérdidas"),

    # ---------------- GRUPO 7 (PyG modelo normal) ----------------
    "7": (PYG, ""),
    "70": (PYG, "1. Importe neto de la cifra de negocios"),
    "700": (PYG, "1. Importe neto de la cifra de negocios / a) Ventas"),
    "701": (PYG, "1. Importe neto de la cifra de negocios / a) Ventas"),
    "702": (PYG, "1. Importe neto de la cifra de negocios / a) Ventas"),
    "703": (PYG, "1. Importe neto de la cifra de negocios / a) Ventas"),
    "704": (PYG, "1. Importe neto de la cifra de negocios / a) Ventas"),
    "705": (PYG, "1. Importe neto de la cifra de negocios / b) Prestaciones de servicios"),
    "706": (PYG, "1. Importe neto de la cifra de negocios / a) Ventas"),
    "708": (PYG, "1. Importe neto de la cifra de negocios / a) Ventas"),
    "709": (PYG, "1. Importe neto de la cifra de negocios / a) Ventas"),
    "71": (PYG, "2. Variación de existencias de productos terminados y en curso de fabricación"),
    "73": (PYG, "3. Trabajos realizados por la empresa para su activo"),
    "74": (PYG, "5. Otros ingresos de explotación / b) Subvenciones de explotación incorporadas al resultado del ejercicio"),
    "746": (PYG, "9. Imputación de subvenciones de inmovilizado no financiero y otras"),
    "75": (PYG, "5. Otros ingresos de explotación / a) Ingresos accesorios y otros de gestión corriente"),
    "76": (PYG, "14. Ingresos financieros"),
    "760": (PYG, "14. Ingresos financieros / a) De participaciones en instrumentos de patrimonio"),
    "761": (PYG, "14. Ingresos financieros / b) De valores negociables y otros instrumentos financieros"),
    "762": (PYG, "14. Ingresos financieros / b) De valores negociables y otros instrumentos financieros"),
    "763": (PYG, "16. Variación de valor razonable en instrumentos financieros / a) Cartera de negociación y otros"),
    "7632": (PYG, "16. Variación de valor razonable en instrumentos financieros / b) Imputación al resultado del ejercicio por activos financieros a valor razonable con cambios en el patrimonio neto"),
    "766": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / b) Resultados por enajenaciones y otras"),
    "767": (PYG, "14. Ingresos financieros / b) De valores negociables y otros instrumentos financieros"),
    "768": (PYG, "17. Diferencias de cambio"),
    "769": (PYG, "14. Ingresos financieros / b) De valores negociables y otros instrumentos financieros"),
    "77": (PYG, ""),
    "770": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / b) Resultados por enajenaciones y otras"),
    "771": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / b) Resultados por enajenaciones y otras"),
    "772": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / b) Resultados por enajenaciones y otras"),
    "773": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / b) Resultados por enajenaciones y otras"),
    "774": (PYG, "12. Diferencia negativa de combinaciones de negocio"),
    "775": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / b) Resultados por enajenaciones y otras"),
    "778": (PYG, "13. Otros resultados"),
    "79": (PYG, ""),
    "790": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / a) Deterioros y pérdidas"),
    "791": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / a) Deterioros y pérdidas"),
    "792": (PYG, "11. Deterioro y resultado por enajenaciones del inmovilizado / a) Deterioros y pérdidas"),
    "793": (PYG, "4. Aprovisionamientos"),
    "7930": (PYG, "2. Variación de existencias de productos terminados y en curso de fabricación"),
    "7931": (PYG, "4. Aprovisionamientos / d) Deterioro de mercaderías, materias primas y otros aprovisionamientos"),
    "7932": (PYG, "4. Aprovisionamientos / d) Deterioro de mercaderías, materias primas y otros aprovisionamientos"),
    "7933": (PYG, "4. Aprovisionamientos / d) Deterioro de mercaderías, materias primas y otros aprovisionamientos"),
    "794": (PYG, "7. Otros gastos de explotación / c) Pérdidas, deterioro y variación de provisiones por operaciones comerciales"),
    "795": (PYG, "10. Excesos de provisiones"),
    "7950": (PYG, "6. Gastos de personal / c) Provisiones"),
    "7954": (PYG, "7. Otros gastos de explotación / c) Pérdidas, deterioro y variación de provisiones por operaciones comerciales"),
    "7957": (PYG, "6. Gastos de personal / c) Provisiones"),
    "796": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / a) Deterioros y pérdidas"),
    "797": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / a) Deterioros y pérdidas"),
    "798": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / a) Deterioros y pérdidas"),
    "799": (PYG, "18. Deterioro y resultado por enajenaciones de instrumentos financieros / a) Deterioros y pérdidas"),

    # ---------------- GRUPOS 8 y 9 (Estado de ingresos y gastos reconocidos) ----------------
    "8": (ECPN, ""),
    "80": (ECPN, f"{ECPN_B} / I. Por valoración de instrumentos financieros"),
    "802": (ECPN, f"{ECPN_C} / VIII. Por valoración de instrumentos financieros"),
    "81": (ECPN, f"{ECPN_B} / II. Por coberturas de flujos de efectivo"),
    "812": (ECPN, f"{ECPN_C} / IX. Por coberturas de flujos de efectivo"),
    "813": (ECPN, f"{ECPN_C} / IX. Por coberturas de flujos de efectivo"),
    "82": (ECPN, f"{ECPN_B} / VI. Diferencias de conversión"),
    "821": (ECPN, f"{ECPN_C} / XII. Diferencias de conversión"),
    "83": (ECPN, f"{ECPN_B} / VII. Efecto impositivo"),
    "836": (ECPN, f"{ECPN_C} / XIII. Efecto impositivo"),
    "837": (ECPN, f"{ECPN_C} / XIII. Efecto impositivo"),
    "84": (ECPN, f"{ECPN_C} / X. Subvenciones, donaciones y legados recibidos"),
    "85": (ECPN, f"{ECPN_B} / IV. Por ganancias y pérdidas actuariales y otros ajustes"),
    "86": (ECPN, f"{ECPN_B} / V. Por activos no corrientes y pasivos vinculados, mantenidos para la venta"),
    "862": (ECPN, f"{ECPN_C} / XI. Por activos no corrientes y pasivos vinculados, mantenidos para la venta"),
    "89": (ECPN, f"{ECPN_B} / I. Por valoración de instrumentos financieros"),
    "9": (ECPN, ""),
    "90": (ECPN, f"{ECPN_B} / I. Por valoración de instrumentos financieros"),
    "902": (ECPN, f"{ECPN_C} / VIII. Por valoración de instrumentos financieros"),
    "91": (ECPN, f"{ECPN_B} / II. Por coberturas de flujos de efectivo"),
    "912": (ECPN, f"{ECPN_C} / IX. Por coberturas de flujos de efectivo"),
    "913": (ECPN, f"{ECPN_C} / IX. Por coberturas de flujos de efectivo"),
    "92": (ECPN, f"{ECPN_B} / VI. Diferencias de conversión"),
    "921": (ECPN, f"{ECPN_C} / XII. Diferencias de conversión"),
    "94": (ECPN, f"{ECPN_B} / III. Subvenciones, donaciones y legados recibidos"),
    "95": (ECPN, f"{ECPN_B} / IV. Por ganancias y pérdidas actuariales y otros ajustes"),
    "96": (ECPN, f"{ECPN_B} / V. Por activos no corrientes y pasivos vinculados, mantenidos para la venta"),
    "962": (ECPN, f"{ECPN_C} / XI. Por activos no corrientes y pasivos vinculados, mantenidos para la venta"),
    "99": (ECPN, f"{ECPN_B} / I. Por valoración de instrumentos financieros"),
    "993": (ECPN, f"{ECPN_C} / VIII. Por valoración de instrumentos financieros"),
    "994": (ECPN, f"{ECPN_C} / VIII. Por valoración de instrumentos financieros"),
}

# ---------------------------------------------------------------------------
# 3. NATURALEZA (saldo habitual).  Por defecto según grupo; prefijos que
#    invierten el signo (gana el prefijo más largo).
# ---------------------------------------------------------------------------
NATURALEZA_DEFECTO = {
    "1": "ACREEDORA", "2": "DEUDORA", "3": "DEUDORA", "4": "DEUDORA",
    "5": "DEUDORA", "6": "DEUDORA", "7": "ACREEDORA", "8": "DEUDORA", "9": "ACREEDORA",
}
NATURALEZA_OVERRIDE = {
    # Grupo 1: cuentas de PN / pasivo con saldo deudor
    "103": "DEUDORA", "104": "DEUDORA", "108": "DEUDORA", "109": "DEUDORA",
    "121": "DEUDORA", "190": "DEUDORA", "192": "DEUDORA", "195": "DEUDORA", "197": "DEUDORA",
    "153": "DEUDORA", "154": "DEUDORA",
    # Grupo 2: amortizaciones y deterioros
    "28": "ACREEDORA", "29": "ACREEDORA", "249": "ACREEDORA", "259": "ACREEDORA",
    # Grupo 3
    "39": "ACREEDORA",
    # Grupo 4
    "40": "ACREEDORA", "406": "DEUDORA", "407": "DEUDORA",
    "41": "ACREEDORA",
    "437": "ACREEDORA", "438": "ACREEDORA", "4337": "ACREEDORA",
    "465": "ACREEDORA", "466": "ACREEDORA",
    "475": "ACREEDORA", "476": "ACREEDORA", "477": "ACREEDORA", "479": "ACREEDORA",
    "485": "ACREEDORA",
    "49": "ACREEDORA",
    # Grupo 5
    "50": "ACREEDORA", "51": "ACREEDORA", "52": "ACREEDORA",
    "539": "ACREEDORA", "549": "ACREEDORA",
    "5531": "ACREEDORA", "5533": "ACREEDORA", "556": "ACREEDORA",
    "5595": "ACREEDORA", "5598": "ACREEDORA",
    "560": "ACREEDORA", "561": "ACREEDORA", "568": "ACREEDORA", "569": "ACREEDORA",
    "585": "ACREEDORA", "586": "ACREEDORA", "587": "ACREEDORA", "588": "ACREEDORA", "589": "ACREEDORA",
    "59": "ACREEDORA",
    # Grupo 6: cuentas de gasto con saldo acreedor
    "606": "ACREEDORA", "608": "ACREEDORA", "609": "ACREEDORA",
    "636": "ACREEDORA", "638": "ACREEDORA", "639": "ACREEDORA",
    # Grupo 7: cuentas de ingreso con saldo deudor
    "706": "DEUDORA", "708": "DEUDORA", "709": "DEUDORA",
}

# ---------------------------------------------------------------------------
# 4. TIPO ANALÍTICO (grupos 6 y 7) — propuesta para empresa de proyectos/servicios
# ---------------------------------------------------------------------------
#
# REGLA DE COHERENCIA (validada en validate_analytic_coherence): el nivel de margen
# implicito en el tipo analitico debe pertenecer al bloque de PyG del epigrafe:
#   epigrafes  1-13 -> resultado de explotacion -> INGRESO_DIRECTO / COSTE_DIRECTO_MC1 /
#                                                  COSTE_DIRECTO_MC2 / INDIRECTO_CECO /
#                                                  AMORTIZACION_DETERIORO / NO_ANALITICO
#   epigrafes 14-19 -> resultado financiero      -> FINANCIERO / NO_ANALITICO
#   epigrafe     20 -> impuesto                  -> NO_ANALITICO
# EXTRAORDINARIO queda sin uso en el seed a proposito: el PGC 2007 suprimio el
# resultado extraordinario. Se conserva en el enum para overrides por organizacion.
TIPO_ANALITICO = {
    "70": "INGRESO_DIRECTO",
    "60": "COSTE_DIRECTO_MC1", "61": "COSTE_DIRECTO_MC1",
    "64": "COSTE_DIRECTO_MC2",
    "71": "COSTE_DIRECTO_MC1",                       # variación existencias productos (signo ingreso)
    "62": "INDIRECTO_CECO", "63": "INDIRECTO_CECO",
    "65": "INDIRECTO_CECO",                          # FIX D-3: 650/651/659 son gasto de explotación (epígrafe 7)
    "68": "AMORTIZACION_DETERIORO", "69": "AMORTIZACION_DETERIORO", "79": "AMORTIZACION_DETERIORO",  # nivel EBIT
    "66": "FINANCIERO", "76": "FINANCIERO",
    "67": "AMORTIZACION_DETERIORO", "77": "AMORTIZACION_DETERIORO",  # FIX D-3: epígrafe 11, dentro de explotación
    # --- FIX D-3: coherencia epígrafe <-> nivel de margen -------------------
    "673": "FINANCIERO", "675": "FINANCIERO",        # epígrafe 18 (resultado financiero)
    "766": "FINANCIERO", "773": "FINANCIERO", "775": "FINANCIERO",
    "678": "INDIRECTO_CECO", "778": "INDIRECTO_CECO",  # epígrafe 13 "Otros resultados" (explotación) -> CECO EXTRAORDINARIO
    "693": "COSTE_DIRECTO_MC1", "793": "COSTE_DIRECTO_MC1",  # epígrafes 2 y 4 (margen bruto)
    "694": "INDIRECTO_CECO", "695": "INDIRECTO_CECO", "794": "INDIRECTO_CECO",  # epígrafe 7.c) (EBITDA)
    "795": "INDIRECTO_CECO",                                                    # epígrafe 10 (EBITDA)
    "696": "FINANCIERO", "697": "FINANCIERO", "698": "FINANCIERO", "699": "FINANCIERO",  # epígrafe 18
    "796": "FINANCIERO", "797": "FINANCIERO", "798": "FINANCIERO", "799": "FINANCIERO",  # epígrafe 18
    # Excepciones
    "630": "NO_ANALITICO", "633": "NO_ANALITICO", "638": "NO_ANALITICO",  # Impuesto sobre beneficios (nivel Resultado)
    "75": "NO_ANALITICO",                                                  # otros ingresos de gestión: configurable por org
}

# ---------------------------------------------------------------------------
# 4.bis MARCAS DE PRESENTACION
# ---------------------------------------------------------------------------
# Cuentas corrientes de saldo indistinto: el `estado_financiero` del CSV es el
# lado DEUDOR; con saldo acreedor el balance debe reclasificarlas al pasivo.
BIDIRECCIONAL = {"551", "552", "554", "555"}   # 553 y 559 son contenedores mixtos con hijos unidireccionales

# ---------------------------------------------------------------------------
# 4.bis CASHFLOW: cuenta -> bucket (E6, tabla de docs/design/E6-validacion-estados.md §3.2)
# ---------------------------------------------------------------------------
# El cashflow DIRECTO clasifica cada movimiento de tesoreria por el bucket de su
# CONTRAPARTIDA, asi que el campo hace falta en casi todo el plan y NO solo en 57x
# (esto invierte el aviso R-18 de E2, ver O-12).
#
# Siete buckets (enum `CashflowBucket` de sistema). La `CashflowCategory` de tres
# valores del modelo de datos se DERIVA del bucket, no se almacena aparte:
#     COBROS_CLIENTES · PAGOS_PROVEEDORES · PAGOS_PERSONAL ·
#     PAGOS_IMPUESTOS · OTROS_EXPLOTACION        -> OPERATING
#     INVERSION                                   -> INVESTING
#     FINANCIACION                                -> FINANCING
#
# Las cuentas 57x quedan VACIAS a proposito: son la propia tesoreria, no una
# contrapartida. Un asiento cuyas unicas lineas son 57x (traspaso banco<->caja)
# tiene variacion 0 y se excluye del informe (R-CF-4).
# Los grupos 8 y 9 (ECPN) tambien quedan vacios: nunca se enfrentan a tesoreria.
#
# Criterios que conviene no perder:
#   · 476 (Seguridad Social) -> PERSONAL, no impuestos: es coste laboral, no tributo.
#   · 66x/76x contra tesoreria -> explotacion: el EFE situa los pagos de intereses
#     y los cobros de intereses/dividendos en 8.b y 8.c, dentro de explotacion.
#   · 407 (anticipo a proveedor) -> PAGOS_PROVEEDORES y 438 (anticipo de cliente)
#     -> COBROS_CLIENTES, aunque el balance los presente en Existencias y en
#     Acreedores: el bucket sigue al flujo, no al epigrafe.
#   · El impuesto sobre beneficios (linea 8.d del EFE) NO es un bucket: se deriva
#     dentro de PAGOS_IMPUESTOS por las claves HP_ACREEDORA_IS / HP_DEUDORA_IS del
#     mapa de la organizacion, para no hardcodear 4752/4709 (R-CF-8).
CASHFLOW_BUCKET = {
    # --- explotacion: clientes
    "43": "COBROS_CLIENTES",
    "438": "COBROS_CLIENTES",
    # --- explotacion: proveedores y acreedores
    "40": "PAGOS_PROVEEDORES",
    "407": "PAGOS_PROVEEDORES",
    "41": "PAGOS_PROVEEDORES",
    # --- explotacion: personal
    "460": "PAGOS_PERSONAL",
    "465": "PAGOS_PERSONAL",
    "466": "PAGOS_PERSONAL",
    "471": "PAGOS_PERSONAL",
    "476": "PAGOS_PERSONAL",
    # --- explotacion: tributos (IVA, retenciones, IS, subvenciones a cobrar)
    "47": "PAGOS_IMPUESTOS",
    # --- explotacion: resto
    "3": "OTROS_EXPLOTACION",     # existencias
    "44": "OTROS_EXPLOTACION",    # deudores varios
    "46": "OTROS_EXPLOTACION",    # 46x que no sean 460/465/466
    "48": "OTROS_EXPLOTACION",    # periodificaciones
    "49": "OTROS_EXPLOTACION",    # deterioro de creditos comerciales
    "55": "OTROS_EXPLOTACION",    # partidas pendientes y c/c vinculadas
    "6": "OTROS_EXPLOTACION",     # gasto pagado al contado (incl. 66x, EFE 8.c)
    "7": "OTROS_EXPLOTACION",     # ingreso cobrado al contado (incl. 76x, EFE 8.b)
    # --- inversion
    "2": "INVERSION",             # inmovilizado, inversiones financieras l/p y sus contra
    "53": "INVERSION",            # inversiones financieras c/p en partes vinculadas
    "54": "INVERSION",            # otras inversiones financieras c/p
    "58": "INVERSION",            # activos no corrientes mantenidos para la venta
    "59": "INVERSION",            # deterioro de inversiones financieras c/p
    # --- financiacion
    "1": "FINANCIACION",          # fondos propios, subvenciones, provisiones y deudas l/p
    "50": "FINANCIACION",         # emprestitos c/p
    "51": "FINANCIACION",         # deudas c/p con partes vinculadas
    "52": "FINANCIACION",         # deudas c/p con entidades de credito y otras
    "56": "FINANCIACION",         # fianzas y depositos recibidos y constituidos
    # --- tesoreria: sin bucket (es el sujeto del informe, no la contrapartida)
    "57": "",
}

# Bucket -> CashflowCategory (funcion pura, no columna redundante)
CASHFLOW_CATEGORY = {
    "COBROS_CLIENTES": "OPERATING", "PAGOS_PROVEEDORES": "OPERATING",
    "PAGOS_PERSONAL": "OPERATING", "PAGOS_IMPUESTOS": "OPERATING",
    "OTROS_EXPLOTACION": "OPERATING",
    "INVERSION": "INVESTING", "FINANCIACION": "FINANCING",
}

# ---------------------------------------------------------------------------
# 4.ter PGC PYMES (RD 1515/2007 consolidado con RD 602/2016 y RD 1/2021)
# ---------------------------------------------------------------------------
# Reglas P-01..P-13 de docs/design/E2-validacion-contable.md §2.1.
# Prefijo -> motivo de exclusion del cuadro de cuentas PYMES.
PYMES_EXCLUIDAS = {
    "8": "P-01 sin ECPN en PYMES", "9": "P-01 sin ECPN en PYMES",
    "133": "P-02 VR con cambios en PN", "134": "P-02 coberturas contables",
    "135": "P-02 diferencias de conversion", "136": "P-02 ANC mantenidos para la venta",
    "137": "P-03 ingresos fiscales a distribuir",
    "1110": "P-04 instrumentos financieros compuestos",
    "178": "P-05 obligaciones y bonos convertibles",
    "140": "P-06 retribuciones l/p prestacion definida", "147": "P-06 pagos en instrumentos de patrimonio",
    "176": "P-07 derivados de cobertura l/p", "255": "P-07 derivados l/p",
    "5593": "P-07 derivado de cobertura c/p", "5598": "P-07 derivado de cobertura c/p",
    "204": "P-08 fondo de comercio (combinaciones de negocio)",
    "774": "P-09 diferencia negativa en combinaciones de negocio",
    "580": "P-10 ANC mantenidos para la venta", "581": "P-10", "582": "P-10", "583": "P-10",
    "584": "P-10", "585": "P-10", "586": "P-10", "587": "P-10", "588": "P-10", "589": "P-10",
    "599": "P-10 deterioro de ANC mantenidos para la venta",
    "643": "P-11 retribuciones l/p aportacion definida",
    "644": "P-11 retribuciones l/p prestacion definida",
    "645": "P-11 retribuciones en instrumentos de patrimonio",
    "6457": "P-11", "7957": "P-11", "7950": "P-11",
    "6632": "P-12 imputacion de VR con cambios en PN", "7632": "P-12",
}
# Excepciones a la exclusion por prefijo (el prefijo excluye, la excepcion rescata).
PYMES_RESCATADAS = {
    "5590": "derivado de cartera de negociacion, SI existe en PYMES",
    "5595": "derivado de cartera de negociacion, SI existe en PYMES",
}

# Renumeracion del modelo de PyG: normal (RD 602/2016) -> PYMES/abreviado.
PYG_NORMAL_A_PYMES = {
    "13.": "12.",   # Otros resultados
    "14.": "13.",   # Ingresos financieros
    "15.": "14.",   # Gastos financieros
    "16.": "15.",   # Variación de valor razonable en instrumentos financieros
    "17.": "16.",   # Diferencias de cambio
    "18.": "17.",   # Deterioro y resultado por enajenaciones de instrumentos financieros
    "19.": "18.",   # Otros ingresos y gastos de carácter financiero
    "20.": "19.",   # Impuestos sobre beneficios
}
# Renumeracion del modelo de balance: normal -> PYMES/abreviado (orden significativo).
BALANCE_NORMAL_A_PYMES = [
    ("A) Patrimonio neto / A-3) Subvenciones", "A) Patrimonio neto / A-2) Subvenciones"),
    ("B) Activo corriente / II. Existencias", "B) Activo corriente / I. Existencias"),
    ("B) Activo corriente / III. Deudores comerciales", "B) Activo corriente / II. Deudores comerciales"),
    ("B) Activo corriente / IV. Inversiones en empresas del grupo", "B) Activo corriente / III. Inversiones en empresas del grupo"),
    ("B) Activo corriente / V. Inversiones financieras", "B) Activo corriente / IV. Inversiones financieras"),
    ("B) Activo corriente / VI. Periodificaciones", "B) Activo corriente / V. Periodificaciones"),
    ("B) Activo corriente / VII. Efectivo", "B) Activo corriente / VI. Efectivo"),
    ("C) Pasivo corriente / II. Provisiones", "C) Pasivo corriente / I. Provisiones"),
    ("C) Pasivo corriente / III. Deudas a corto plazo", "C) Pasivo corriente / II. Deudas a corto plazo"),
    ("C) Pasivo corriente / IV. Deudas con empresas del grupo", "C) Pasivo corriente / III. Deudas con empresas del grupo"),
    ("C) Pasivo corriente / V. Acreedores comerciales", "C) Pasivo corriente / IV. Acreedores comerciales"),
    ("C) Pasivo corriente / VI. Periodificaciones", "C) Pasivo corriente / V. Periodificaciones"),
    ("C) Pasivo corriente / VII. Deuda con características especiales", "C) Pasivo corriente / VI. Deuda con características especiales"),
]


def en_pymes(code):
    """True si la cuenta forma parte del cuadro del PGC PYMES."""
    for n in range(len(code), 0, -1):
        pref = code[:n]
        if pref in PYMES_RESCATADAS:
            return True
        if pref in PYMES_EXCLUIDAS:
            return False
    return True


def epigrafe_pymes(estado, epigrafe):
    """Traduce un epigrafe del modelo normal al modelo PYMES/abreviado."""
    if not epigrafe:
        return ""
    if estado == "PYG":
        for k in sorted(PYG_NORMAL_A_PYMES, key=len, reverse=True):
            if epigrafe.startswith(k):
                return PYG_NORMAL_A_PYMES[k] + epigrafe[len(k):]
        return epigrafe
    out = epigrafe
    for src, dst in BALANCE_NORMAL_A_PYMES:
        if out.startswith(src):
            out = dst + out[len(src):]
            break
    return out


# ---------------------------------------------------------------------------
# 5. Construcción
# ---------------------------------------------------------------------------
def _longest_prefix(code, table):
    for n in range(len(code), 0, -1):
        if code[:n] in table:
            return table[code[:n]]
    return None


def build_rows():
    rows = []
    for codigo, nombre in CUENTAS:
        nivel = len(codigo)
        grupo = codigo[0]
        padre = codigo[:-1] if nivel > 1 else ""
        nat = _longest_prefix(codigo, NATURALEZA_OVERRIDE) or NATURALEZA_DEFECTO[grupo]
        estado, epigrafe = _longest_prefix(codigo, MAPEO) or ("", "")
        if grupo in ("6", "7"):
            tipo = _longest_prefix(codigo, TIPO_ANALITICO) or "NO_ANALITICO"
            if nivel == 1:
                tipo = ""
        else:
            tipo = ""
        bidi = 1 if _longest_prefix_key(codigo, BIDIRECCIONAL) else 0
        # is_contra: la naturaleza contradice el estado -> la cuenta MINORA su masa.
        contra = 0
        if not bidi:
            if estado == "BALANCE_ACTIVO" and nat == "ACREEDORA":
                contra = 1
            elif estado in ("BALANCE_PASIVO", "BALANCE_PN") and nat == "DEUDORA":
                contra = 1
            elif estado == "PYG" and grupo == "6" and nat == "ACREEDORA":
                contra = 1
            elif estado == "PYG" and grupo == "7" and nat == "DEUDORA":
                contra = 1
        pym = 1 if en_pymes(codigo) else 0
        epi_p = epigrafe_pymes(estado, epigrafe) if pym else ""
        cfb = _longest_prefix(codigo, CASHFLOW_BUCKET)
        cfb = "" if cfb is None else cfb
        rows.append(OrderedDict([
            ("codigo", codigo), ("nombre", nombre), ("nivel", nivel), ("padre", padre),
            ("grupo", grupo), ("naturaleza", nat), ("estado_financiero", estado),
            ("epigrafe", epigrafe), ("tipo_analitico", tipo),
            ("bidireccional", bidi), ("is_contra", contra),
            ("pymes", pym), ("epigrafe_pymes", epi_p),
            ("cashflow_bucket", cfb),
        ]))
    return rows


def _longest_prefix_key(code, keyset):
    for n in range(len(code), 0, -1):
        if code[:n] in keyset:
            return True
    return False


# Bloques de la PyG por numero de epigrafe -> tipos analiticos admisibles.
_EXPLOTACION = {"INGRESO_DIRECTO", "COSTE_DIRECTO_MC1", "COSTE_DIRECTO_MC2",
                "INDIRECTO_CECO", "AMORTIZACION_DETERIORO", "NO_ANALITICO"}
_FINANCIERO = {"FINANCIERO", "NO_ANALITICO"}
_IMPUESTO = {"NO_ANALITICO"}


def validate_analytic_coherence(rows):
    """El tipo analitico debe pertenecer al bloque de PyG de su epigrafe."""
    errs = []
    for r in rows:
        if r["estado_financiero"] != "PYG" or not r["epigrafe"] or not r["tipo_analitico"]:
            continue
        num = r["epigrafe"].split(".")[0]
        if not num.isdigit():
            continue
        n = int(num)
        allowed = _EXPLOTACION if n <= 13 else (_FINANCIERO if n <= 19 else _IMPUESTO)
        if r["tipo_analitico"] not in allowed:
            errs.append(f'{r["codigo"]} epigrafe "{r["epigrafe"][:40]}" (bloque {n}) '
                        f'incompatible con tipo_analitico {r["tipo_analitico"]}')
    assert not errs, "Incoherencia epigrafe <-> tipo_analitico:\n  " + "\n  ".join(errs)


def validate(rows):
    codes = [r["codigo"] for r in rows]
    dupes = [c for c, n in Counter(codes).items() if n > 1]
    assert not dupes, f"Códigos duplicados: {dupes}"
    known = set(codes)
    missing = [r["codigo"] for r in rows if r["padre"] and r["padre"] not in known]
    assert not missing, f"Padres inexistentes para: {missing}"
    bad_len = [r["codigo"] for r in rows if len(r["codigo"]) != r["nivel"] or not 1 <= r["nivel"] <= 4]
    assert not bad_len, f"Nivel/longitud incoherente: {bad_len}"
    assert all(r["codigo"].isdigit() for r in rows), "Códigos no numéricos"
    for r in rows:
        if r["grupo"] in "12345":
            assert r["tipo_analitico"] == "", r["codigo"]
    # --- integridad de las columnas nuevas ---
    pymes_codes = {r["codigo"] for r in rows if r["pymes"] == 1}
    huerfanas = [r["codigo"] for r in rows
                 if r["pymes"] == 1 and r["padre"] and r["padre"] not in pymes_codes]
    assert not huerfanas, f"PYMES: padres filtrados con hijo superviviente: {huerfanas}"
    sin_epi = [r["codigo"] for r in rows
               if r["pymes"] == 1 and r["epigrafe"] and not r["epigrafe_pymes"]]
    assert not sin_epi, f"PYMES: epigrafe sin traduccion: {sin_epi}"
    fuera = [r["codigo"] for r in rows if r["pymes"] == 0 and r["epigrafe_pymes"]]
    assert not fuera, f"epigrafe_pymes en cuenta no PYMES: {fuera}"
    assert all(r["bidireccional"] in (0, 1) and r["is_contra"] in (0, 1) for r in rows)
    # una cuenta no puede ser a la vez bidireccional y contra
    assert not [r["codigo"] for r in rows if r["bidireccional"] and r["is_contra"]]
    validate_analytic_coherence(rows)
    validate_cashflow(rows)
    return Counter(r["grupo"] for r in rows)


# Codigos que legitimamente NO llevan bucket: la propia tesoreria y los dos
# contenedores mixtos de nivel 1 cuyos hijos si lo llevan todos.
_SIN_BUCKET_OK = ("57",)
_CONTENEDORES_SIN_BUCKET = {"4", "5"}


def validate_cashflow(rows):
    """`cashflow_bucket` exhaustivo: toda cuenta de los grupos 1-7 que pueda ser
    contrapartida de un movimiento de tesoreria tiene bucket. La exhaustividad es
    lo que hace que I6 no pueda fallar en silencio por una cuenta sin clasificar."""
    valid = set(CASHFLOW_CATEGORY)
    malos = [r["codigo"] for r in rows if r["cashflow_bucket"] and r["cashflow_bucket"] not in valid]
    assert not malos, f"cashflow_bucket desconocido en: {malos}"
    faltan = [r["codigo"] for r in rows
              if r["grupo"] in "1234567"
              and not r["codigo"].startswith(_SIN_BUCKET_OK)
              and r["codigo"] not in _CONTENEDORES_SIN_BUCKET
              and not r["cashflow_bucket"]]
    assert not faltan, f"cuentas de grupo 1-7 sin cashflow_bucket: {faltan}"
    sobran = [r["codigo"] for r in rows
              if r["cashflow_bucket"] and (r["codigo"].startswith(_SIN_BUCKET_OK)
                                           or r["grupo"] in "89")]
    assert not sobran, f"cashflow_bucket en tesoreria o en grupos 8/9: {sobran}"
    # Coherencia padre-hijo: un hijo solo puede cambiar de bucket si su prefijo
    # esta declarado explicitamente en CASHFLOW_BUCKET (evita derivas silenciosas).
    by_code = {r["codigo"]: r for r in rows}
    incoherentes = [r["codigo"] for r in rows
                    if r["padre"] and r["padre"] in by_code
                    and r["cashflow_bucket"] != by_code[r["padre"]]["cashflow_bucket"]
                    and r["codigo"] not in CASHFLOW_BUCKET
                    and by_code[r["padre"]]["cashflow_bucket"]]
    assert not incoherentes, f"hijo con bucket distinto del padre sin regla propia: {incoherentes}"


def render(rows):
    import io
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()), lineterminator="\r\n")
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


def main():
    args = [a for a in sys.argv[1:] if a != "--check"]
    check = "--check" in sys.argv[1:]
    out = args[0] if args else os.path.join(os.path.dirname(os.path.abspath(__file__)), "npgc.csv")
    rows = build_rows()
    counts = validate(rows)
    text = render(rows)
    if check:
        if not os.path.exists(out):
            print(f"falta {out}", file=sys.stderr)
            return 1
        with open(out, newline="", encoding="utf-8") as fh:
            if fh.read() != text:
                print(f"{out} difiere de la reconstruccion", file=sys.stderr)
                return 1
        print(f"OK: {out} reproducible byte a byte ({len(rows)} filas)")
        print_counts(rows, counts)
        return 0
    with open(out, "w", newline="", encoding="utf-8") as fh:
        fh.write(text)
    print(f"OK: {len(rows)} filas escritas en {out}")
    print_counts(rows, counts)
    return 0


def print_counts(rows, counts):
    print("grupo | filas | niv1 | niv2 | niv3 | niv4 | pymes")
    for g in sorted(counts):
        lv = Counter(r["nivel"] for r in rows if r["grupo"] == g)
        pg = sum(1 for r in rows if r["grupo"] == g and r["pymes"] == 1)
        print(f"  {g}   | {counts[g]:5d} | {lv[1]:4d} | {lv[2]:4d} | {lv[3]:4d} | {lv[4]:4d} | {pg:5d}")
    print(f"TOTAL | {len(rows):5d} |      |      |      |      | "
          f"{sum(1 for r in rows if r['pymes'] == 1):5d}")
    print(f"bidireccionales: {sum(r['bidireccional'] for r in rows)} | "
          f"contra-cuentas: {sum(r['is_contra'] for r in rows)} | "
          f"excluidas de PYMES: {sum(1 for r in rows if r['pymes'] == 0)}")
    ta = Counter(r["tipo_analitico"] for r in rows if r["tipo_analitico"])
    print("tipo_analitico: " + " · ".join(f"{k}={v}" for k, v in sorted(ta.items())))
    cb = Counter(r["cashflow_bucket"] for r in rows if r["cashflow_bucket"])
    print("cashflow_bucket: " + " · ".join(f"{k}={v}" for k, v in sorted(cb.items())))
    cc = Counter(CASHFLOW_CATEGORY[r["cashflow_bucket"]] for r in rows if r["cashflow_bucket"])
    print("  -> categoria: " + " · ".join(f"{k}={v}" for k, v in sorted(cc.items()))
          + f" · sin bucket (57x + contenedores + grupos 8/9): "
          + f"{sum(1 for r in rows if not r['cashflow_bucket'])}")


if __name__ == "__main__":
    raise SystemExit(main())
