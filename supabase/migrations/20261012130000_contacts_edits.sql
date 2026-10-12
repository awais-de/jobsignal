-- Contacts edited in the app (name, company, role ...) keep the owner's version: a later
-- Connections.csv import skips them, so a connection who moved jobs isn't moved back.
alter table contacts add column manually_edited boolean not null default false;
